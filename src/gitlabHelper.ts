import { Gitlab } from '@gitbeaker/node';
import {
  DiscussionNote,
  DiscussionSchema,
  IssueSchema,
  MergeRequestSchema,
  MilestoneSchema,
  NoteSchema,
  UserSchema,
} from '@gitbeaker/core/dist/types/types';
import { GitlabSettings } from './settings';
import axios from 'axios';
import { warn, error, debug } from 'loglevel';

const console = {
  log: warn,
  warn: warn,
  error,
  debug,
};

export type GitLabDiscussion = DiscussionSchema;
export type GitLabDiscussionNote = DiscussionNote;
export type GitLabIssue = IssueSchema;
export type GitLabNote = NoteSchema;
export type GitLabUser = Omit<UserSchema, 'created_at'>;
export type GitLabMilestone = MilestoneSchema;
export type GitLabMergeRequest = MergeRequestSchema;

export class GitlabHelper {
  // Wait for this issue to be resolved
  // https://github.com/jdalrymple/gitbeaker/issues/793
  gitlabApi: InstanceType<typeof Gitlab>;

  gitlabUrl?: string;
  gitlabToken: string;
  gitlabProjectId: number;
  archived?: boolean;
  sessionCookie: string;

  host: string;
  projectPath?: string;
  allBranches: any;

  constructor(
    gitlabApi: InstanceType<typeof Gitlab>,
    gitlabSettings: GitlabSettings
  ) {
    this.gitlabApi = gitlabApi;
    this.gitlabUrl = gitlabSettings.url;
    this.gitlabToken = gitlabSettings.token;
    this.gitlabProjectId = gitlabSettings.projectId;
    this.host = gitlabSettings.url ? gitlabSettings.url : 'https://gitlab.com';
    this.host = this.host.endsWith('/')
      ? this.host.substring(0, this.host.length - 1)
      : this.host;
    this.archived = gitlabSettings.listArchivedProjects ?? true;
    this.sessionCookie = gitlabSettings.sessionCookie;
    this.allBranches = null;
  }

  async releasesEnabled(gitlabProjectId: number): Promise<boolean> {
    try {
      const releases = await this.gitlabApi.Releases.all(gitlabProjectId);
      return releases.length > -1;
    } catch (err) {
      if (err.response && err.response.statusCode === 403) {
        console.debug(`Releases are disabled for project ${gitlabProjectId} on Gitlab.`);
      } else {
        console.error(err);
        console.error('An error occurred while checking for releases:');
      }
      return false;
    }
  }
  /**
   * List all projects that the GitLab user is associated with.
   */
  async listProjects() {
    try {
      let projects;
      if (this.archived) {
        projects = await this.gitlabApi.Projects.all({ membership: true });
      } else {
        projects = await this.gitlabApi.Projects.all({ membership: true, archived: this.archived });
      }

      // print each project with info
      for (let project of projects) {
        console.log(
          project.id.toString(),
          '\t',
          project.name,
          '\t--\t',
          project['description']
        );
      }

      // instructions for user
      console.log('\n\n');
      console.log(
        'Select which project ID should be transported to github. Edit the settings.js accordingly. (gitlab.projectID)'
      );
      console.log('\n\n');
    } catch (err) {
      console.error('An Error occured while fetching all GitLab projects:');
      console.error(err);
      throw err;
    }
  }

  /**
   * Stores project path in a field
   */
  async registerProjectPath(project_d: number) {
    try {
      const project = await this.gitlabApi.Projects.show(project_d);
      this.projectPath = project['path_with_namespace'];
    } catch (err) {
      console.error('An Error occured while fetching all GitLab projects:');
      console.error(err);
      throw err;
    }
  }

  /**
   * Gets all notes for a given issue.
   */
  async getIssueNotes(issueIid: number): Promise<GitLabNote[]> {
    try {
      return await this.gitlabApi.IssueNotes.all(
        this.gitlabProjectId,
        issueIid,
        {}
      ).then((issueNotes) => issueNotes.filter((issueNote) => !issueNote.confidential));
    } catch (err) {
      console.error(`Could not fetch notes for GitLab issue #${issueIid}.`);
      return [];
    }
  }

  /**
   * Checks if merge requests are enabled for the project.
   */
  async areMergeRequestsEnabled(gitlabProjectId: number): Promise<boolean> {
    try {
      const project = await this.gitlabApi.Projects.show(gitlabProjectId);
      
      if ('merge_requests_enabled' in project) {
        return project.merge_requests_enabled;
      } else {
        console.warn(`Project ${gitlabProjectId} does not have 'merge_requests_enabled' in the response.`);
        return false;
      }
    } catch (err) {
      console.error(`Error fetching project ${gitlabProjectId}: ${err.message}`);
      if (err.response) {
        console.error(`GitLab API response: ${err.response.status} - ${err.response.statusText}`);
      }
      return false;
    }
  }

  /**
   * Gets attachment using http get
   */
  async getAttachment(relurl: string, asStream = false): Promise<Buffer | NodeJS.ReadableStream | null> {

    const url = new URL(`${this.host}/api/v4/projects/${relurl}`);
    try {
      const data = (
        await axios.get(url.toString(), {
          responseType: asStream ? 'stream' : 'arraybuffer',
          headers: {
            'PRIVATE-TOKEN': this.gitlabToken,
          },
        })
      ).data;
      return asStream ? data : Buffer.from(data, 'binary');
    } catch (err) {
      console.error(`Could not download attachment ${relurl}: ${err?.response?.statusText}`);
      console.error('Is your session cookie still valid?');
      return null;
    }
  }

  /**
   * Gets all branches.
   */
  async getAllBranches() {
    if (!this.allBranches) {
      this.allBranches = await this.gitlabApi.Branches.all(
        this.gitlabProjectId
      );
    }
    return this.allBranches as any[];
  }

  async getMergeRequestApprovals(mergeRequestIid: number): Promise<string[]> {
    try {
      let approvals = await this.gitlabApi.MergeRequestApprovals.configuration(
        this.gitlabProjectId,
        {
          mergerequestIid: mergeRequestIid,
        },
      );
      if (approvals.approved_by) {
        return approvals.approved_by.map(user => user.user.username);
      }
      
      console.log(`No approvals found for GitLab merge request !${mergeRequestIid}.`)
    } catch (err) {
      console.error(
        `Could not fetch approvals for GitLab merge request !${mergeRequestIid}: ${err}`
      );
      throw err;
    }
    return [];
  }

  /**
   * Gets all notes for a given merge request.
   */
  async getAllMergeRequestNotes(pullRequestIid: number): Promise<GitLabNote[]> {
    try {
      return this.gitlabApi.MergeRequestNotes.all(
        this.gitlabProjectId,
        pullRequestIid,
        {}
      );
    } catch (err) {
      console.error(
        `Could not fetch notes for GitLab merge request #${pullRequestIid}.`
      );
      return [];
    }
  }

  /**
   * Gets all notes for a given merge request.
   */
  async getAllMergeRequestDiscussions(pullRequestIid: number): Promise<GitLabDiscussion[]> {
    try {
      return this.gitlabApi.MergeRequestDiscussions.all(
        this.gitlabProjectId,
        pullRequestIid,
        {}
      );
    } catch (err) {
      console.error(
        `Could not fetch notes for GitLab merge request #${pullRequestIid}.`
      );
      return [];
    }
  }
}
