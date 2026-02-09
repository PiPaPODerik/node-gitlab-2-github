import assert from 'node:assert/strict';
import test from 'node:test';

import { buildIssuesWithPlaceholders } from './issue-placeholders';
import { GitLabIssue } from './gitlabHelper';

const createIssue = (iid: number, confidential = false): GitLabIssue =>
({
  id: iid,
  iid,
  title: `Issue ${iid}`,
  description: `Issue ${iid}`,
  state: 'opened',
  web_url: `https://gitlab.test/issues/${iid}`,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  confidential
} as GitLabIssue);

test('buildIssuesWithPlaceholders fills gaps in iid sequence', () => {
  const issues = [createIssue(1), createIssue(3)];
  const placeholders: number[] = [];

  const result = buildIssuesWithPlaceholders(
    issues,
    (expectedIdx, issue) => ({
      ...createIssue(expectedIdx, issue.confidential ?? false),
      isPlaceholder: true
    }) as GitLabIssue,
    expectedIdx => placeholders.push(expectedIdx)
  );

  assert.deepEqual(
    result.map(issue => issue.iid),
    [1, 2, 3]
  );
  assert.deepEqual(placeholders, [2]);
});

test('buildIssuesWithPlaceholders returns original issues when no gaps', () => {
  const issues = [createIssue(1), createIssue(2), createIssue(3)];

  const result = buildIssuesWithPlaceholders(
    issues,
    expectedIdx => ({ ...createIssue(expectedIdx), isPlaceholder: true }) as GitLabIssue
  );

  assert.deepEqual(
    result.map(issue => issue.iid),
    [1, 2, 3]
  );
});

test('buildIssuesWithPlaceholders creates multiple placeholders for large gaps', () => {
  const issues = [createIssue(1), createIssue(5)];
  const placeholders: number[] = [];

  const result = buildIssuesWithPlaceholders(
    issues,
    expectedIdx => ({ ...createIssue(expectedIdx), isPlaceholder: true }) as GitLabIssue,
    expectedIdx => placeholders.push(expectedIdx)
  );

  assert.deepEqual(
    result.map(issue => issue.iid),
    [1, 2, 3, 4, 5]
  );
  assert.deepEqual(placeholders, [2, 3, 4]);
});
