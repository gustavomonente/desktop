import {
  RepositoriesDatabase,
  IDatabaseGitHubRepository,
  IDatabaseOwner,
  IDatabaseProtectedBranch,
} from '../databases/repositories-database'
import { Owner } from '../../models/owner'
import { GitHubRepository } from '../../models/github-repository'
import { Repository } from '../../models/repository'
import { fatalError } from '../fatal-error'
import { IAPIRepository, IAPIBranch } from '../api'
import { BaseStore } from './base-store'
import { enableBranchProtectionWarning } from '../feature-flag'

/** The store for local repositories. */
export class RepositoriesStore extends BaseStore {
  private db: RepositoriesDatabase

  // Key-repo ID, Value-date
  private lastStashCheckCache = new Map<number, number>()

  private branchProtectionCache = new Map<string, boolean>()

  public constructor(db: RepositoriesDatabase) {
    super()

    this.db = db
  }

  /** Find the matching GitHub repository or add it if it doesn't exist. */
  public async upsertGitHubRepository(
    endpoint: string,
    apiRepository: IAPIRepository
  ): Promise<GitHubRepository> {
    return this.db.transaction(
      'rw',
      this.db.repositories,
      this.db.gitHubRepositories,
      this.db.owners,
      async () => {
        const gitHubRepository = await this.db.gitHubRepositories
          .where('cloneURL')
          .equals(apiRepository.clone_url)
          .limit(1)
          .first()

        if (gitHubRepository == null) {
          return this.putGitHubRepository(endpoint, apiRepository)
        } else {
          return this.buildGitHubRepository(gitHubRepository)
        }
      }
    )
  }

  private async buildGitHubRepository(
    dbRepo: IDatabaseGitHubRepository
  ): Promise<GitHubRepository> {
    const owner = await this.db.owners.get(dbRepo.ownerID)

    if (owner == null) {
      throw new Error(`Couldn't find the owner for ${dbRepo.name}`)
    }

    let parent: GitHubRepository | null = null
    if (dbRepo.parentID) {
      parent = await this.findGitHubRepositoryByID(dbRepo.parentID)
    }

    return new GitHubRepository(
      dbRepo.name,
      new Owner(owner.login, owner.endpoint, owner.id!),
      dbRepo.id!,
      dbRepo.private,
      dbRepo.htmlURL,
      dbRepo.defaultBranch,
      dbRepo.cloneURL,
      parent
    )
  }

  /** Find a GitHub repository by its DB ID. */
  public async findGitHubRepositoryByID(
    id: number
  ): Promise<GitHubRepository | null> {
    const gitHubRepository = await this.db.gitHubRepositories.get(id)
    if (!gitHubRepository) {
      return null
    }

    return this.buildGitHubRepository(gitHubRepository)
  }

  /** Get all the local repositories. */
  public getAll(): Promise<ReadonlyArray<Repository>> {
    return this.db.transaction(
      'r',
      this.db.repositories,
      this.db.gitHubRepositories,
      this.db.owners,
      async () => {
        const inflatedRepos = new Array<Repository>()
        const repos = await this.db.repositories.toArray()
        for (const repo of repos) {
          let inflatedRepo: Repository | null = null
          let gitHubRepository: GitHubRepository | null = null
          if (repo.gitHubRepositoryID) {
            gitHubRepository = await this.findGitHubRepositoryByID(
              repo.gitHubRepositoryID
            )
          }

          inflatedRepo = new Repository(
            repo.path,
            repo.id!,
            gitHubRepository,
            repo.missing
          )
          inflatedRepos.push(inflatedRepo)
        }

        return inflatedRepos
      }
    )
  }

  /**
   * Add a new local repository.
   *
   * If a repository already exists with that path, it will be returned instead.
   */
  public async addRepository(path: string): Promise<Repository> {
    const repository = await this.db.transaction(
      'rw',
      this.db.repositories,
      this.db.gitHubRepositories,
      this.db.owners,
      async () => {
        const repos = await this.db.repositories.toArray()
        const record = repos.find(r => r.path === path)
        let recordId: number
        let gitHubRepo: GitHubRepository | null = null

        if (record != null) {
          recordId = record.id!

          if (record.gitHubRepositoryID != null) {
            gitHubRepo = await this.findGitHubRepositoryByID(
              record.gitHubRepositoryID
            )
          }
        } else {
          recordId = await this.db.repositories.add({
            path,
            gitHubRepositoryID: null,
            missing: false,
            lastStashCheckDate: null,
          })
        }

        return new Repository(path, recordId, gitHubRepo, false)
      }
    )

    this.emitUpdate()

    return repository
  }

  /** Remove the repository with the given ID. */
  public async removeRepository(repoID: number): Promise<void> {
    await this.db.repositories.delete(repoID)

    this.emitUpdate()
  }

  /** Update the repository's `missing` flag. */
  public async updateRepositoryMissing(
    repository: Repository,
    missing: boolean
  ): Promise<Repository> {
    const repoID = repository.id
    if (!repoID) {
      return fatalError(
        '`updateRepositoryMissing` can only update `missing` for a repository which has been added to the database.'
      )
    }

    const gitHubRepositoryID = repository.gitHubRepository
      ? repository.gitHubRepository.dbID
      : null
    const oldRecord = await this.db.repositories.get(repoID)
    const lastStashCheckDate =
      oldRecord !== undefined ? oldRecord.lastStashCheckDate : null

    await this.db.repositories.put({
      id: repository.id,
      path: repository.path,
      missing,
      gitHubRepositoryID,
      lastStashCheckDate,
    })

    this.emitUpdate()

    return new Repository(
      repository.path,
      repository.id,
      repository.gitHubRepository,
      missing
    )
  }

  /** Update the repository's path. */
  public async updateRepositoryPath(
    repository: Repository,
    path: string
  ): Promise<Repository> {
    const repoID = repository.id
    if (!repoID) {
      return fatalError(
        '`updateRepositoryPath` can only update the path for a repository which has been added to the database.'
      )
    }

    const gitHubRepositoryID = repository.gitHubRepository
      ? repository.gitHubRepository.dbID
      : null
    const oldRecord = await this.db.repositories.get(repoID)
    const lastStashCheckDate =
      oldRecord !== undefined ? oldRecord.lastStashCheckDate : null

    await this.db.repositories.put({
      id: repository.id,
      missing: false,
      path,
      gitHubRepositoryID,
      lastStashCheckDate,
    })

    this.emitUpdate()

    return new Repository(
      path,
      repository.id,
      repository.gitHubRepository,
      false
    )
  }

  /**
   * Sets the last time the repository was checked for stash entries
   *
   * @param repository The repository in which to update the last stash check date for
   * @param date The date and time in which the last stash check took place; defaults to
   * the current time
   */
  public async updateLastStashCheckDate(
    repository: Repository,
    date: number = Date.now()
  ): Promise<void> {
    const repoID = repository.id
    if (repoID === 0) {
      return fatalError(
        '`updateLastStashCheckDate` can only update the last stash check date for a repository which has been added to the database.'
      )
    }

    await this.db.repositories.update(repoID, {
      lastStashCheckDate: date,
    })

    this.lastStashCheckCache.set(repoID, date)

    this.emitUpdate()
  }

  /**
   * Gets the last time the repository was checked for stash entries
   *
   * @param repository The repository in which to update the last stash check date for
   */
  public async getLastStashCheckDate(
    repository: Repository
  ): Promise<number | null> {
    const repoID = repository.id
    if (!repoID) {
      return fatalError(
        '`getLastStashCheckDate` - can only retrieve the last stash check date for a repositories that have been stored in the database.'
      )
    }

    let lastCheckDate = this.lastStashCheckCache.get(repoID) || null
    if (lastCheckDate !== null) {
      return lastCheckDate
    }

    const record = await this.db.repositories.get(repoID)

    if (record === undefined) {
      return fatalError(
        `'getLastStashCheckDate' - unable to find repository with ID: ${repoID}`
      )
    }

    lastCheckDate = record.lastStashCheckDate
    if (lastCheckDate !== null) {
      this.lastStashCheckCache.set(repoID, lastCheckDate)
    }

    return lastCheckDate
  }

  private async putOwner(endpoint: string, login: string): Promise<Owner> {
    login = login.toLowerCase()

    const existingOwner = await this.db.owners
      .where('[endpoint+login]')
      .equals([endpoint, login])
      .first()
    if (existingOwner) {
      return new Owner(login, endpoint, existingOwner.id!)
    }

    const dbOwner: IDatabaseOwner = {
      login,
      endpoint,
    }
    const id = await this.db.owners.add(dbOwner)
    return new Owner(login, endpoint, id)
  }

  private async putGitHubRepository(
    endpoint: string,
    gitHubRepository: IAPIRepository
  ): Promise<GitHubRepository> {
    let parent: GitHubRepository | null = null
    if (gitHubRepository.parent) {
      parent = await this.putGitHubRepository(endpoint, gitHubRepository.parent)
    }

    const login = gitHubRepository.owner.login.toLowerCase()
    const owner = await this.putOwner(endpoint, login)

    const existingRepo = await this.db.gitHubRepositories
      .where('[ownerID+name]')
      .equals([owner.id!, gitHubRepository.name])
      .first()

    let updatedGitHubRepo: IDatabaseGitHubRepository = {
      ownerID: owner.id!,
      name: gitHubRepository.name,
      private: gitHubRepository.private,
      htmlURL: gitHubRepository.html_url,
      defaultBranch: gitHubRepository.default_branch,
      cloneURL: gitHubRepository.clone_url,
      parentID: parent ? parent.dbID : null,
      lastPruneDate: null,
    }
    if (existingRepo) {
      updatedGitHubRepo = { ...updatedGitHubRepo, id: existingRepo.id }
    }

    const id = await this.db.gitHubRepositories.put(updatedGitHubRepo)
    return new GitHubRepository(
      updatedGitHubRepo.name,
      owner,
      id,
      updatedGitHubRepo.private,
      updatedGitHubRepo.htmlURL,
      updatedGitHubRepo.defaultBranch,
      updatedGitHubRepo.cloneURL,
      parent
    )
  }

  /** Add or update the repository's GitHub repository. */
  public async updateGitHubRepository(
    repository: Repository,
    endpoint: string,
    gitHubRepository: IAPIRepository,
    branches: ReadonlyArray<IAPIBranch>
  ): Promise<Repository> {
    const repoID = repository.id
    if (!repoID) {
      return fatalError(
        '`updateGitHubRepository` can only update a GitHub repository for a repository which has been added to the database.'
      )
    }

    const updatedGitHubRepo = await this.db.transaction(
      'rw',
      this.db.repositories,
      this.db.gitHubRepositories,
      this.db.protectedBranches,
      this.db.owners,
      async () => {
        const localRepo = (await this.db.repositories.get(repoID))!
        const updatedGitHubRepo = await this.putGitHubRepository(
          endpoint,
          gitHubRepository
        )

        await this.db.repositories.update(localRepo.id!, {
          gitHubRepositoryID: updatedGitHubRepo.dbID,
        })

        if (enableBranchProtectionWarning()) {
          const repoId = updatedGitHubRepo.dbID!

          // This update flow is organized into two stages:
          //
          // - update the in-memory cache
          // - update the underyling database state
          //
          // This should ensure any stale values are not being used, and avoids
          // the need to query the database while the results are in memory.

          const prefix = getKeyPrefix(repoId)

          for (const key of this.branchProtectionCache.keys()) {
            // invalidate any cached entries belonging to this repository
            if (key.startsWith(prefix)) {
              this.branchProtectionCache.delete(key)
            }
          }

          const branchRecords = branches.map<IDatabaseProtectedBranch>(b => ({
            repoId,
            name: b.name,
          }))

          // update cached values to avoid database lookup
          for (const item of branchRecords) {
            const key = getKey(repoId, item.name)
            this.branchProtectionCache.set(key, true)
          }

          await this.db.protectedBranches
            .where('repoId')
            .equals(repoId)
            .delete()

          await this.db.protectedBranches.bulkAdd(branchRecords)
        }

        return updatedGitHubRepo
      }
    )

    this.emitUpdate()

    return new Repository(
      repository.path,
      repository.id,
      updatedGitHubRepo,
      repository.missing
    )
  }

  /**
   * Set's the last time the repository was checked for pruning
   *
   * @param repository The repository in which to update the prune date for
   * @param date The date and time in which the last prune took place
   */
  public async updateLastPruneDate(
    repository: Repository,
    date: number
  ): Promise<void> {
    const repoID = repository.id
    if (repoID === 0) {
      return fatalError(
        '`updateLastPruneDate` can only update the last prune date for a repository which has been added to the database.'
      )
    }

    const githubRepo = repository.gitHubRepository
    if (githubRepo === null) {
      return fatalError(
        `'updateLastPruneDate' can only update GitHub repositories`
      )
    }

    const gitHubRepositoryID = githubRepo.dbID
    if (gitHubRepositoryID === null) {
      return fatalError(
        `'updateLastPruneDate' can only update GitHub repositories with a valid ID: received ID of ${gitHubRepositoryID}`
      )
    }

    await this.db.gitHubRepositories.update(gitHubRepositoryID, {
      lastPruneDate: date,
    })

    this.emitUpdate()
  }

  public async getLastPruneDate(
    repository: Repository
  ): Promise<number | null> {
    const repoID = repository.id
    if (!repoID) {
      return fatalError(
        '`getLastPruneDate` - can only retrieve the last prune date for a repositories that have been stored in the database.'
      )
    }

    const githubRepo = repository.gitHubRepository
    if (githubRepo === null) {
      return fatalError(
        `'getLastPruneDate' - can only retrieve the last prune date for GitHub repositories.`
      )
    }

    const gitHubRepositoryID = githubRepo.dbID
    if (gitHubRepositoryID === null) {
      return fatalError(
        `'getLastPruneDate' - can only retrieve the last prune date for GitHub repositories that have been stored in the database.`
      )
    }

    const record = await this.db.gitHubRepositories.get(gitHubRepositoryID)

    if (record === undefined) {
      return fatalError(
        `'getLastPruneDate' - unable to find GitHub repository with ID: ${gitHubRepositoryID}`
      )
    }

    return record!.lastPruneDate
  }

  public async isBranchProtected(
    gitHubRepository: GitHubRepository,
    branchName: string
  ): Promise<boolean> {
    if (gitHubRepository.dbID === null) {
      return fatalError(
        'unable to get protected branches, GitHub repository has a null dbID'
      )
    }

    const key = getKey(gitHubRepository.dbID, branchName)

    const existing = this.branchProtectionCache.get(key)
    if (existing !== undefined) {
      return existing
    }

    const result = await this.db.protectedBranches.get([
      gitHubRepository.dbID,
      branchName,
    ])

    const value = result !== undefined

    this.branchProtectionCache.set(key, value)

    return value
  }
}

/** Compute the key for the branch protection cache */
function getKey(dbID: number, branchName: string) {
  return `${getKeyPrefix(dbID)}${branchName}`
}

/** Compute the key prefix for the branch protection cache */
function getKeyPrefix(dbID: number) {
  return `${dbID}-`
}
