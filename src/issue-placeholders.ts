import { GitLabIssue } from './gitlabHelper';

type PlaceholderFactory = (expectedIdx: number, issue: GitLabIssue) => GitLabIssue;
type PlaceholderCallback = (expectedIdx: number, sourceIssue: GitLabIssue) => void;

export const buildIssuesWithPlaceholders = (
  issues: GitLabIssue[],
  createPlaceholder: PlaceholderFactory,
  onPlaceholder?: PlaceholderCallback
): GitLabIssue[] => {
  const issuesWithPlaceholders: GitLabIssue[] = [];
  let expectedIdx = 1;

  for (const issue of issues) {
    while (expectedIdx < issue.iid) {
      issuesWithPlaceholders.push(createPlaceholder(expectedIdx, issue));
      if (onPlaceholder) {
        onPlaceholder(expectedIdx, issue);
      }
      expectedIdx++;
    }
    issuesWithPlaceholders.push(issue);
    expectedIdx++;
  }

  return issuesWithPlaceholders;
};
