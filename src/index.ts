import {
  GithubHelper,
  MilestoneImport,
  SimpleLabel,
  SimpleMilestone
} from './githubHelper';
import { GitlabHelper, GitLabIssue, GitLabMilestone } from './gitlabHelper';
import settings from '../settings';
import { readProjectsFromCsv } from './utils';

import { Octokit as GitHubApi } from '@octokit/rest';
import { throttling } from '@octokit/plugin-throttling';
import { createAppAuth } from '@octokit/auth-app';
import { Gitlab } from '@gitbeaker/node';

import { default as readlineSync } from 'readline-sync';
import * as fs from 'fs';

import AWS from 'aws-sdk';
import * as attachmentsHandler from './attachmentsHandler';
import {
  levels as logLevels,
  setLevel as setLogLevel,
  error,
  debug,
  warn
} from 'loglevel';

import { ATTACHMENTS_FILE_PATH } from './intput-output-files';
import { CCWARN } from './constants';

const console = {
  log: warn,
  error,
  debug,
  warn,
};

const loglevel = logLevels[process.env?.LOGLEVEL?.toUpperCase()] || logLevels.INFO;
setLogLevel(loglevel);

const logMigrationAbortedDueToExistingIssues = (projectUrl) => console.error(`\x1b[31m\n\nIssue and MergeRequst migration for project '${projectUrl}' aborted! There are existing Issues or PullRequests in the GitHub repository. Migrating would lead to inconsisten issue numbers and falty links between issues. Switch off Issue Migration or recreate the repository to transfer Issues and Merge Requests.\n\x1b[0m`);

const counters = {
  nrOfPlaceholderIssues: 0,
  nrOfReplacementIssues: 0,
  nrOfFailedIssues: 0,
  nrOfPlaceholderMilestones: 0,
};

if (settings.s3) {
  AWS.config.credentials = new AWS.Credentials({
    accessKeyId: settings.s3.accessKeyId,
    secretAccessKey: settings.s3.secretAccessKey,
  });
}

// Ensure that the GitLab token has been set in settings.js
if (
  !settings.gitlab.token ||
  settings.gitlab.token === '{{gitlab private token}}'
) {
  console.log(
    '\n\nYou have to enter your GitLab private token in the settings.js file.'
  );
  process.exit(1);
}

// Create a GitLab API object
const gitlabApi = new Gitlab({
  host: settings.gitlab.url ? settings.gitlab.url : 'http://gitlab.com',
  token: settings.gitlab.token,
});

const MyOctokit = GitHubApi.plugin(throttling);

// Check if GitHub App credentials are provided for automatic token refresh
const useGitHubApp = settings.github.appId && settings.github.installationId && settings.github.privateKey;

// Normalize private key - handle escaped newlines from environment variables
let normalizedPrivateKey = settings.github.privateKey;
if (normalizedPrivateKey?.includes(String.raw`\n`)) {
  normalizedPrivateKey = normalizedPrivateKey.replaceAll(String.raw`\n`, '\n');
}

const authSettings = useGitHubApp
  ? {
    authStrategy: createAppAuth,
    auth: {
      appId: settings.github.appId,
      privateKey: normalizedPrivateKey,
      installationId: settings.github.installationId,
    },
  }
  : {
    auth: 'token ' + settings.github.token,
  };
// Create a GitHub API object
const githubApi = new MyOctokit({
  previews: settings.useIssueImportAPI ? ['golden-comet'] : [],
  debug: false,
  baseUrl: settings.github.apiUrl
    ? settings.github.apiUrl
    : 'https://api.github.com',
  timeout: 5000,
  headers: {
    'user-agent': 'node-gitlab-2-github', // GitHub is happy with a unique user agent
    accept: 'application/vnd.github.v3+json',
  },
  ...authSettings,
  throttle: {
    onRateLimit: async (retryAfter, options, octokit, retryCount) => {
      console.log(
        `Request quota exhausted for request ${options.method} ${options.url}`
      );
      console.log(`Retrying after ${retryAfter} seconds!`);
      return true;
    },
    onSecondaryRateLimit: async (retryAfter, options, octokit, retryCount) => {
      console.log(
        `SecondaryRateLimit detected for request ${options.method} ${options.url}`
      )
      console.log(`Retrying after ${retryAfter} seconds!`);
      return true;
    },
    fallbackSecondaryRateRetryAfter: 600,
  },
});

if (useGitHubApp) {
  warn('\x1b[90mGitHub App authentication enabled - tokens will refresh automatically\x1b[0m');
}
const defaultDelayInMS = 200;
const delayInMS = parseInt(process.env.GL2GH_DELAY_MS) || defaultDelayInMS;
console.log(`Using a delay of ${delayInMS}ms for requests to Github`);

const gitlabHelper = new GitlabHelper(gitlabApi, settings.gitlab);
const githubHelper = new GithubHelper(
  githubApi,
  settings.github,
  gitlabHelper,
  settings.useIssuesForAllMergeRequests,
  delayInMS
);

let projectMap: Map<number, [string, string]> = new Map();

if (settings.csvImport?.projectMapCsv) {
  console.log(`Loading projects from CSV: ${settings.csvImport.projectMapCsv}`);
  projectMap = readProjectsFromCsv(
    settings.csvImport.projectMapCsv,
    settings.csvImport.gitlabProjectIdColumn,
    settings.csvImport.gitlabProjectPathColumn,
    settings.csvImport.githubProjectPathColumn
  );
} else {
  projectMap.set(settings.gitlab.projectId, ['', '']);
}

(async () => {
  if (projectMap.size === 0 || (projectMap.size === 1 && projectMap.has(0))) {
    await gitlabHelper.listProjects();
  } else {
    for (const projectId of projectMap.keys()) {
      const paths = projectMap.get(projectId);

      if (!paths) {
        console.warn(`Warning: No paths found for project ID ${projectId}, skipping`);
        continue;
      }

      const [gitlabPath, githubPath] = paths;

      console.log(`\n\n${'='.repeat(60)}`);
      if (gitlabPath) {
        console.log(`Processing Project ID: ${projectId} ${gitlabPath} → GitHub: ${githubPath}`);
      } else {
        console.log(`Processing Project ID: ${projectId}`);
      }
      console.log(`${'='.repeat(60)}\n`);

      settings.gitlab.projectId = projectId;
      gitlabHelper.gitlabProjectId = projectId;

      if (githubPath) {
        const githubParts = githubPath.split('/');
        if (githubParts.length === 2) {
          settings.github.owner = githubParts[0];
          settings.github.repo = githubParts[1];

          githubHelper.githubOwner = githubParts[0];
          githubHelper.githubRepo = githubParts[1];
        } else {
          settings.github.repo = githubPath;
          githubHelper.githubRepo = githubPath;
        }
      }

      if (settings.github.recreateRepo === true) {
        await recreate();
      }
      await migrate();
    }
  }
})().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});

// ----------------------------------------------------------------------------

/**
 * Asks for confirmation and maybe recreates the GitHub repository.
 */
async function recreate() {
  readlineSync.setDefaultOptions({
    limit: ['no', 'yes'],
    limitMessage: 'Please enter yes or no',
    defaultInput: 'no',
  });
  const ans = readlineSync.question('Delete and recreate? [yes/no] ');
  if (ans == 'yes') await githubHelper.recreateRepo();
  else console.log("OK, I won't delete anything then.");
}

/**
 * Creates dummy data for a placeholder milestone
 *
 * @param expectedIdx Number of the GitLab milestone
 * @returns Data for the milestone
 */
function createPlaceholderMilestone(expectedIdx: number): MilestoneImport {
  return {
    id: -1, // dummy
    iid: expectedIdx,
    title: `[PLACEHOLDER] - for milestone #${expectedIdx}`,
    description:
      'This milestone does not exist on GitLab and only exists to ensure that milestone numbers in GitLab and GitHub are the same, to ensure proper linking with milestones. If the migration was successful, this milestone can be deleted.',
    state: 'closed',
  };
}

/**
 * Creates dummy data for a placeholder issue
 *
 * @param expectedIdx Number of the GitLab issue
 * @returns Data for the issue
 */
function createPlaceholderIssue(expectedIdx: number, issue?: GitLabIssue): Partial<GitLabIssue> {
  const description = `This issue does not exist on GitLab and only exists to ensure that issue numbers in GitLab and GitHub are the same, to ensure proper linking between issues. If the migration was successful, this issue can be deleted. /n ${issue?.web_url ?? ''}`;
  const title = `[PLACEHOLDER] - for issue #${expectedIdx}`;
  return {
    iid: expectedIdx,
    title,
    description,
    state: 'closed',
    isPlaceholder: true,
  };
}

/**
 * Creates dummy data for a placeholder confidential issue
 *
 * @param expectedIdx Number of the GitLab issue
 * @returns Data for the issue
 */
function createPlaceholderConfidentialIssue(expectedIdx: number, issue?: GitLabIssue): Partial<GitLabIssue> {
  const description = `This issue is confidential on GitLab and was excluded during Migration. Otherwise sensitive Information would have been leaked. It only exists to ensure that issue numbers in GitLab and GitHub are the same, to ensure proper linking between issues. If the migration was successful, this issue can be deleted. /n ${issue?.web_url ?? ''}`;
  const title = `[PLACEHOLDER] - for confidential issue #${expectedIdx}`;
  return {
    iid: expectedIdx,
    title,
    description,
    state: 'closed',
    isPlaceholder: true,
  };
}

// ----------------------------------------------------------------------------

/**
 * Creates a so-called "replacement-issue".
 *
 * This is used for issues where the migration fails. The replacement issue will
 * have the same number and title, but the original description will be lost.
 */
function createReplacementIssue(issue: GitLabIssue) {
  let description = `The original issue\n\n\tId: ${issue.iid}\n\tTitle: ${issue.title}\n\ncould not be created.\nThis is a dummy issue, replacing the original one.`;

  if (issue.web_url) {
    description += `In case the gitlab repository still exists, visit the following link to see the original issue:\n\n${issue.web_url}`;
  }

  return {
    iid: issue.iid,
    title: `${issue.title} [REPLACEMENT ISSUE]`,
    description,
    state: issue.state,
    created_at: issue.created_at,
  };
}

// ----------------------------------------------------------------------------

/**
 * Performs all of the migration tasks to move a GitLab repo to GitHub
 */
async function migrate() {
  //
  // Sequentially transfer repo things
  //

  try {
    await prepareOutputs(ATTACHMENTS_FILE_PATH);

    if (await githubHelper.hasIssuesOrMergeRequets()) {
      console.error('Issues or Merge Requests already exist in the GitHub repository.');
      logMigrationAbortedDueToExistingIssues(settings.github.repo);

      process.exit(1);
    }
    const skipReleases = !await gitlabHelper.releasesEnabled(settings.gitlab.projectId);
    if (skipReleases) {
      settings.transfer.releases = false;
    }
    await githubHelper.registerRepoId();
    await gitlabHelper.registerProjectPath(settings.gitlab.projectId);

    if (settings.transfer.description) {
      await transferDescription();
    }

    if (settings.transfer.milestones) {
      await transferMilestones(
        settings.usePlaceholderMilestonesForMissingMilestones,
        settings.transfer.ancestorMilestones
      );
    }

    if (settings.transfer.labels) {
      await transferLabels(true, settings.conversion.useLowerCaseLabels);
    }

    if (settings.transfer.releases) {
      await transferReleases();
    }

    // Important: do this before transferring the merge requests
    if (settings.transfer.issues) {
      await transferIssues();
    }

    if (settings.transfer.mergeRequests && await gitlabHelper.areMergeRequestsEnabled(settings.gitlab.projectId)) {
      settings.mergeRequests.log ? await logMergeRequests(settings.mergeRequests.logFile) : await transferMergeRequests();
    } else {
      console.warn('Merge requests are disabled for this project. Skipping merge request migration.');
    }

    await attachmentsHandler.writeAttachmentsInfoToDisk(ATTACHMENTS_FILE_PATH);

    if (skipReleases) {
      console.warn(CCWARN, 'Releases migration skipped as they are disabled for this project on GitLab.');
    }

    if (settings.exportUsers) {
      const users = Array.from(githubHelper.users.values()).join("\n");
      fs.writeFileSync('users.txt', users);
    }
  } catch (err) {
    console.error('Error during transfer:');
    console.error(err);
    process.exit(1);
  }

  await waitForOpenFileHandlesToClose();
  console.log('\n\nTransfer complete!\n\n');


  async function prepareOutputs(attachmentJsonPath) {
    console.log(`Using attatchment.json path: ${attachmentJsonPath}`);
    if (fs.existsSync(attachmentJsonPath)) {
      await fs.promises.rm(attachmentJsonPath, { force: true });
      console.debug(`Deleted ${attachmentJsonPath}.`);
    }
  }
}

async function waitForOpenFileHandlesToClose() {
  const startTime = Date.now();
  const maxWaitTime = 30000; // 30 seconds
  while (attachmentsHandler.getOpenFileHandles() > 0) {
    if (Date.now() - startTime > maxWaitTime) {
      console.error('Timed out while waiting for open file handles to close. Stop waiting.');
      break;
    }
    console.log(`Waiting for ${attachmentsHandler.getOpenFileHandles()} open file handles to close...`);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

// ----------------------------------------------------------------------------

/**
 * Transfer the description of the repository.
 */
async function transferDescription() {
  inform('Transferring Description');

  let project = await gitlabApi.Projects.show(settings.gitlab.projectId);

  if (project.description) {
    await githubHelper.updateRepositoryDescription(project.description);
    console.log('Done.');
  } else {
    console.log('Description is empty, nothing to transfer.')
  }
}

// ----------------------------------------------------------------------------

/**
 * Transfer any milestones that exist in GitLab that do not exist in GitHub.
 */
async function transferMilestones(usePlaceholders: boolean, includeAncestors: boolean = false) {
  inform('Transferring Milestones');

  // Get a list of all milestones associated with this project
  // FIXME: don't use type join but ensure everything is milestoneImport
  const milestones: (GitLabMilestone | MilestoneImport)[] =
    await gitlabApi.ProjectMilestones.all(settings.gitlab.projectId, { include_ancestors: includeAncestors });

  // sort milestones in ascending order of when they were created (by id)
  const projectMilestones = milestones.filter(m => { return (m as GitLabMilestone)?.project_id === settings.gitlab.projectId }).sort((a, b) => a.id - b.id);
  const ancestorMilestones = milestones.filter(m => { return (m as GitLabMilestone)?.project_id !== settings.gitlab.projectId }).sort((a, b) => a.id - b.id);

  // get a list of the current milestones in the new GitHub repo (likely to be empty)
  const githubMilestones = await githubHelper.getAllGithubMilestones();
  let lastMilestoneId = 0;
  projectMilestones.forEach(milestone => {
    lastMilestoneId = Math.max(lastMilestoneId, milestone.iid);
  });

  let milestoneMap = new Map<number, SimpleMilestone>();
  for (let i = 0; i < projectMilestones.length; i++) {
    let milestone = projectMilestones[i];
    let expectedIdx = i + 1; // GitLab internal Id (iid)

    // Create placeholder milestones so that new GitHub milestones will have
    // the same milestone number as in GitLab. Gaps are caused by deleted
    // milestones
    if (usePlaceholders && milestone.iid !== expectedIdx) {
      let placeholder = createPlaceholderMilestone(expectedIdx);
      projectMilestones.splice(i, 0, placeholder);
      counters.nrOfPlaceholderMilestones++;
      console.log(
        `Added placeholder milestone for GitLab milestone %${expectedIdx}.`
      );
      milestoneMap.set(expectedIdx, {
        number: expectedIdx,
        title: placeholder.title,
      });
    } else {
      milestoneMap.set(milestone.iid, {
        number: expectedIdx,
        title: milestone.title,
      });
    }
  }

  await githubHelper.registerMilestoneMap(milestoneMap);

  // if a GitLab milestone does not exist in GitHub repo, create it.
  const allMileStones = putOnTop(ancestorMilestones, projectMilestones);

  for (const milestone of allMileStones) {
    const foundMilestone = githubMilestones.find(
      m => m.title === milestone.title
    );
    if (!foundMilestone) {
      console.log('Creating: ' + milestone.title);
      await githubHelper
        .createMilestone(milestone)
        .then(created => {
          let m = milestoneMap.get(milestone.iid);
          if (m && m.number != created.number) {
            throw new Error(
              `Mismatch between milestone ${m.number}: '${m.title}' in map and created ${created.number}: '${created.title}'`
            );
          }
        })
        .catch(err => {
          console.error(`Error creating milestone '${milestone.title}'.`);
          console.error(err);
        });
    } else {
      console.log('Already exists: ' + milestone.title);
    }
  }
}
function putOnTop(ancestorMilestones: (GitLabMilestone | MilestoneImport)[], bottom: (GitLabMilestone | MilestoneImport)[]): (GitLabMilestone | MilestoneImport)[] {
  let nextiid = ancestorMilestones.reduce((acc, m) => {
    if (m.iid > acc) {
      acc = m.iid;
    }
    return acc;
  }, 0) + 1;
  const ancestorsWithNewIids = ancestorMilestones.map(m => {
    return { ...m, iid: nextiid++ };
  });

  return [...bottom, ...ancestorsWithNewIids];
}

// ----------------------------------------------------------------------------

/**
 * Transfer any labels that exist in GitLab that do not exist in GitHub.
 */
async function transferLabels(attachmentLabel = true, useLowerCase = true) {
  inform('Transferring Labels');
  console.warn(CCWARN, 'NOTE (2022): GitHub descriptions are limited to 100 characters, and do not accept 4-byte Unicode');

  const invalidUnicode = /[\u{10000}-\u{10FFFF}]|(?![*#0-9]+)[\p{Emoji}\p{Emoji_Modifier}\p{Emoji_Component}\p{Emoji_Modifier_Base}\p{Emoji_Presentation}]/gu;

  // Get a list of all labels associated with this project
  let labels: SimpleLabel[] = await gitlabApi.Labels.all(
    settings.gitlab.projectId
  );

  // get a list of the current label names in the new GitHub repo (likely to be just the defaults)
  let githubLabels: string[] = await githubHelper.getAllGithubLabelNames();

  // create a hasAttachment label for manual attachment migration
  if (attachmentLabel) {
    const hasAttachmentLabel = {
      name: 'has attachment',
      color: '#fbca04',
      description: 'Attachment was not transfered from GitLab',
    };
    labels.push(hasAttachmentLabel);
  }

  const gitlabMergeRequestLabel = {
    name: 'Merge Request from Gitlab',
    color: '#b36b00',
    description: '',
  };
  labels.push(gitlabMergeRequestLabel);

  // if a GitLab label does not exist in GitHub repo, create it.
  for (let label of labels) {
    // GitHub prefers lowercase label names
    if (useLowerCase) label.name = label.name.toLowerCase();

    if (!githubLabels.find(l => l === label.name)) {
      console.log('Creating: ' + label.name);

      if (label.description) {
        if (label.description.match(invalidUnicode)) {
          console.warn(CCWARN, `⚠️ Removed invalid unicode characters from description.`);
          const cleanedDescription = label.description.replace(invalidUnicode, '').trim();
          console.debug(` "${label.description}"\n\t to\n "${cleanedDescription}"`);
          label.description = cleanedDescription;
        }
        if (label.description.length > 100) {
          const trimmedDescription = label.description.slice(0, 100).trim();
          if (settings.trimOversizedLabelDescriptions) {
            console.warn(CCWARN, `⚠️ Description too long (${label.description.length}), it was trimmed:`);
            console.debug(` "${label.description}"\n\t to\n "${trimmedDescription}"`);
            label.description = trimmedDescription;
          } else {
            console.warn(CCWARN, `⚠️ Description too long (${label.description.length}), it was excluded.`);
            console.debug(` "${label.description}"`);
            label.description = '';
          }
        }
      }

      try {
        // process asynchronous code in sequence
        await githubHelper.createLabel(label).catch(x => { });
      } catch (err) {
        console.error('Could not create label', label.name);
        console.error(err);
      }
    } else {
      console.log('Already exists: ' + label.name);
    }
  }
}

// ----------------------------------------------------------------------------

/**
 * Transfer any issues and their comments that exist in GitLab that do not exist in GitHub.
 */
async function transferIssues() {
  inform('Transferring Issues');

  await githubHelper.registerMilestoneMap();

  // get a list of all GitLab issues associated with this project
  // TODO return all issues via pagination
  let issues = (await gitlabApi.Issues.all({
    projectId: settings.gitlab.projectId,
    labels: settings.filterByLabel
  }) as GitLabIssue[]).map(issue => {
    return issue?.confidential ? createPlaceholderConfidentialIssue(issue.iid, issue) : issue;
  }) as GitLabIssue[];

  // sort issues in ascending order of their issue number (by iid)
  issues = issues.sort((a, b) => a.iid - b.iid);

  // get a list of the current issues in the new GitHub repo (likely to be empty)
  let githubIssues = await githubHelper.getAllGithubIssues();

  console.log(`Transferring ${issues.length} issues.`);

  if (settings.usePlaceholderIssuesForMissingIssues) {
    for (let i = 0; i < issues.length; i++) {
      // GitLab issue internal Id (iid)
      let expectedIdx = i + 1;

      // is there a gap in the GitLab issues or a confidentail issue?
      // Create placeholder issues so that new GitHub issues will have the same
      // issue number as in GitLab. If a placeholder is used it is because there
      // was a gap in GitLab issues -- likely caused by a deleted or confidential GitLab issue.
      if (issues[i].iid !== expectedIdx) {
        issues.splice(i, 0, createPlaceholderIssue(expectedIdx, issues[i]) as GitLabIssue); // HACK: remove type coercion
        counters.nrOfPlaceholderIssues++;
        console.log(
          issues[i].confidential ?
            `Added placeholder issue for GitLab confidential issue #${expectedIdx}.` :
            `Added placeholder issue for GitLab issue #${expectedIdx}.`
        );
      }
    }
  }

  //
  // Create GitHub issues for each GitLab issue
  //

  // if a GitLab issue does not exist in GitHub repo, create it -- along with comments.
  for (let issue of issues) {
    // try to find a GitHub issue that already exists for this GitLab issue
    let githubIssue = githubIssues.find(
      i => i.title.trim() === issue.title.trim() && i.body.includes(issue.web_url)
    );
    if (!githubIssue) {
      console.log(`\nMigrating issue #${issue.iid} ('${issue.title}')...`);
      try {
        // process asynchronous code in sequence -- treats the code sort of like blocking
        await githubHelper.createIssueAndComments(issue);
        console.log(`...DONE migrating issue #${issue.iid}.`);
      } catch (err) {
        console.log(`...ERROR while migrating issue #${issue.iid}.`);

        console.error('DEBUG:\n', err); // TODO delete this after issue-migration-fails have been fixed

        if (settings.useReplacementIssuesForCreationFails) {
          console.log('\t-> creating a replacement issue...');
          const replacementIssue = createReplacementIssue(issue);
          try {
            await githubHelper.createIssueAndComments(
              replacementIssue as GitLabIssue
            ); // HACK: remove type coercion

            counters.nrOfReplacementIssues++;
            console.error('\t...DONE.');
          } catch (err) {
            counters.nrOfFailedIssues++;
            console.error(
              '\t...ERROR: Could not create replacement issue either!'
            );
            throw err;
          }
        }
      }
    } else {
      console.log(`Updating issue #${issue.iid} - ${issue.title}...`);
      try {
        await githubHelper.updateIssueState(githubIssue, issue);
        console.log(`...Done updating issue #${issue.iid}.`);
      } catch (err) {
        console.log(`...ERROR while updating issue #${issue.iid}.`);
      }
    }
  }

  // print statistics about issue migration:
  console.log(`DONE creating issues.`);
  console.log(`\nStatistics:`);
  console.log(`Total nr. of issues: ${issues.length}`);
  console.log(
    `Nr. of used placeholder issues: ${counters.nrOfPlaceholderIssues}`
  );
  console.log(
    `Nr. of used replacement issues: ${counters.nrOfReplacementIssues}`
  );
  console.log(`Nr. of issue migration fails: ${counters.nrOfFailedIssues}`);
}
// ----------------------------------------------------------------------------

/**
 * Transfer any merge requests that exist in GitLab that do not exist in GitHub
 * TODO - Update all text references to use the new issue numbers;
 *        GitHub treats pull requests as issues, therefore their numbers are changed
 * @returns {Promise<void>}
 */
async function transferMergeRequests() {
  inform('Transferring Merge Requests');

  await githubHelper.registerMilestoneMap();

  // Get a list of all pull requests (merge request equivalent) associated with
  // this project
  let mergeRequests = await gitlabApi.MergeRequests.all({
    projectId: settings.gitlab.projectId,
    labels: settings.filterByLabel,
  });

  // Sort merge requests in ascending order of their number (by iid)
  mergeRequests = mergeRequests.sort((a, b) => a.iid - b.iid);

  // Get a list of the current pull requests in the new GitHub repo (likely to
  // be empty)
  let githubPullRequests = await githubHelper.getAllGithubPullRequests();

  // get a list of the current issues in the new GitHub repo (likely to be empty)
  // Issues are sometimes created from Gitlab merge requests. Avoid creating duplicates.
  let githubIssues = await githubHelper.getAllGithubIssues();

  console.log(
    'Transferring ' + mergeRequests.length.toString() + ' merge requests'
  );

  //
  // Create GitHub pull request for each GitLab merge request
  //

  // if a GitLab merge request does not exist in GitHub repo, create it -- along
  // with comments
  for (let mr of mergeRequests) {
    // Try to find a GitHub pull request that already exists for this GitLab
    // merge request
    let githubRequest = githubPullRequests.find(
      i => i.title.trim() === mr.title.trim() && i.body.includes(mr.web_url)
    );
    let githubIssue = githubIssues.find(
      // allow for issues titled "Original Issue Name - [merged|closed]"
      i => {
        // regex needs escaping in case merge request title contains special characters
        const regex = new RegExp(escapeRegExp(mr.title.trim()) + ' - \\[(merged|closed)\\]');
        return regex.test(i.title.trim()) && i.body.includes(mr.web_url);
      }
    );
    if (!githubRequest && !githubIssue) {
      if (settings.skipMergeRequestStates.includes(mr.state)) {
        console.log(
          `Skipping MR ${mr.iid} in "${mr.state}" state: ${mr.title}`
        );
        continue;
      }
      console.log('Creating pull request: !' + mr.iid + ' - ' + mr.title);
      try {
        // process asynchronous code in sequence
        await githubHelper.createPullRequestAndComments(mr);
      } catch (err) {
        console.error(
          'Could not create pull request: !' + mr.iid + ' - ' + mr.title
        );
        console.error(err);
        // Stop execution to be able to correct issue
        process.exit(1);
      }
    } else {
      if (githubRequest) {
        console.log(
          'Gitlab merge request already exists (as github pull request): ' +
          mr.iid +
          ' - ' +
          mr.title
        );
        githubHelper.updatePullRequestState(githubRequest, mr);
      } else {
        console.log(
          'Gitlab merge request already exists (as github issue): ' +
          mr.iid +
          ' - ' +
          mr.title
        );
      }
    }
  }
}

/**
 * Transfer any releases that exist in GitLab that do not exist in GitHub
 * Please note that due to github api restrictions, this only transfers the
 * name, description and tag name of the release. It sorts the releases chronologically
 * and creates them on github one by one
 * @returns {Promise<void>}
 */
async function transferReleases() {
  inform('Transferring Releases');

  // Get a list of all releases associated with this project
  let releases = await gitlabApi.Releases.all(settings.gitlab.projectId);

  // Sort releases in ascending order of their release date
  releases = releases.sort((a, b) => {
    return (new Date(a.released_at) as any) - (new Date(b.released_at) as any);
  });

  console.log('Transferring ' + releases.length.toString() + ' releases');

  //
  // Create GitHub release for each GitLab release
  //

  // if a GitLab release does not exist in GitHub repo, create it
  for (let release of releases) {
    // Try to find an existing github release that already exists for this GitLab
    // release
    let githubRelease = await githubHelper.getReleaseByTag(release.tag_name);

    if (!githubRelease) {
      console.log(
        'Creating release: !' + release.name + ' - ' + release.tag_name
      );
      try {
        // process asynchronous code in sequence
        await githubHelper.createRelease(
          release.tag_name,
          release.name,
          release.description
        );
      } catch (err) {
        console.error(
          'Could not create release: !' +
          release.name +
          ' - ' +
          release.tag_name
        );
        console.error(err);
      }
    } else {
      console.log(
        'Gitlab release already exists (as github release): ' +
        githubRelease.data.name +
        ' - ' +
        githubRelease.data.tag_name
      );
    }
  }
}

//-----------------------------------------------------------------------------

/**
 * logs merge requests that exist in GitLab to a file.
 */
async function logMergeRequests(logFile: string) {
  inform('Logging Merge Requests');

  // get a list of all GitLab merge requests associated with this project
  // TODO return all MRs via pagination
  let mergeRequests = await gitlabApi.MergeRequests.all({
    projectId: settings.gitlab.projectId,
    labels: settings.filterByLabel,
  });

  // sort MRs in ascending order of when they were created (by id)
  mergeRequests = mergeRequests.sort((a, b) => a.id - b.id);

  console.log('Logging ' + mergeRequests.length.toString() + ' merge requests');

  for (let mr of mergeRequests) {
    let mergeRequestDiscussions = await gitlabApi.MergeRequestDiscussions.all(
      settings.gitlab.projectId,
      mr.iid
    );
    let mergeRequestNotes = await gitlabApi.MergeRequestNotes.all(
      settings.gitlab.projectId,
      mr.iid,
      {}
    );

    mr.discussions = mergeRequestDiscussions ? mergeRequestDiscussions : [];
    mr.notes = mergeRequestNotes ? mergeRequestNotes : [];
  }

  //
  // Log the merge requests to a file
  //
  const output = { mergeRequests: mergeRequests };

  fs.writeFileSync(logFile, JSON.stringify(output, null, 2));
}

// ----------------------------------------------------------------------------

/**
 * Print out a section heading to let the user know what is happening
 */
function inform(msg: string) {
  console.log('==================================');
  console.log(msg);
  console.log('==================================');
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}
