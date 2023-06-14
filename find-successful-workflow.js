const { Octokit } = require("@octokit/action");
const core = require("@actions/core");
const github = require("@actions/github");
const { execSync } = require("child_process");
const { existsSync } = require("fs");

const {
  runId,
  repo: { repo, owner },
  eventName,
} = github.context;
const eventPayload = require(process.env.GITHUB_EVENT_PATH);
process.env.GITHUB_TOKEN = process.argv[2];
const mainBranchName = process.argv[3];
const errorOnNoSuccessfulWorkflow = process.argv[4];
const lastSuccessfulEvent = process.argv[5];
const workingDirectory = process.argv[6];
const workflowId = process.argv[7];
const defaultWorkingDirectory = ".";

let BASE_SHA;
(async () => {
  if (workingDirectory !== defaultWorkingDirectory) {
    if (existsSync(workingDirectory)) {
      process.chdir(workingDirectory);
    } else {
      process.stdout.write("\n");
      process.stdout.write(
        `WARNING: Working directory '${workingDirectory}' doesn't exist.\n`
      );
    }
  }

  const HEAD_SHA = execSync(`git rev-parse HEAD`, { encoding: "utf-8" });

  const closedPullRequest =
    eventName == "pull_request" &&
    eventPayload.action == "closed" &&
    eventPayload.pull_request.merged == true;

  if (eventName === "pull_request" && !closedPullRequest) {
    BASE_SHA = execSync(`git merge-base origin/${mainBranchName} HEAD`, {
      encoding: "utf-8",
    });
  } else {
    try {
      BASE_SHA = await findSuccessfulCommit(
        workflowId,
        runId,
        owner,
        repo,
        mainBranchName,
        lastSuccessfulEvent
      );
    } catch (e) {
      core.setFailed(e.message);
      return;
    }

    if (!BASE_SHA) {
      if (errorOnNoSuccessfulWorkflow === "true") {
        reportFailure(mainBranchName);
        return;
      } else {
        process.stdout.write("\n");
        process.stdout.write(
          `WARNING: Unable to find a successful workflow run on 'origin/${mainBranchName}'\n`
        );
        process.stdout.write(
          `We are therefore defaulting to use HEAD~1 on 'origin/${mainBranchName}'\n`
        );
        process.stdout.write("\n");
        process.stdout.write(
          `NOTE: You can instead make this a hard error by setting 'error-on-no-successful-workflow' on the action in your workflow.\n`
        );

        BASE_SHA = execSync(`git rev-parse origin/${mainBranchName}~1`, {
          encoding: "utf-8",
        });
        core.setOutput("noPreviousBuild", "true");
      }
    } else {
      process.stdout.write("\n");
      process.stdout.write(
        `Found the last successful workflow run on 'origin/${mainBranchName}'\n`
      );
      process.stdout.write(`Commit: ${BASE_SHA}\n`);
    }
  }

  const stripNewLineEndings = (sha) => sha.replace("\n", "");
  core.setOutput("base", stripNewLineEndings(BASE_SHA));
  core.setOutput("head", stripNewLineEndings(HEAD_SHA));
})();

function reportFailure(branchName) {
  core.setFailed(`
    Unable to find a successful workflow run on 'origin/${branchName}'
    NOTE: You have set 'error-on-no-successful-workflow' on the action so this is a hard error.

    Is it possible that you have no runs currently on 'origin/${branchName}'?
    - If yes, then you should run the workflow without this flag first.
    - If no, then you might have changed your git history and those commits no longer exist.`);
}

/**
 * Find last successful workflow run on the repo
 * @param {string?} workflow_id
 * @param {number} run_id
 * @param {string} owner
 * @param {string} repo
 * @param {string} branch
 * @returns
 */
async function findSuccessfulCommit(
  workflow_id,
  run_id,
  owner,
  repo,
  branch,
  lastSuccessfulEvent
) {
  const octokit = new Octokit();
  if (!workflow_id) {
    workflow_id = await octokit
      .request(`GET /repos/${owner}/${repo}/actions/runs/${run_id}`, {
        owner,
        repo,
        branch,
        run_id,
      })
      .then(({ data: { workflow_id } }) => workflow_id);
    process.stdout.write("\n");
    process.stdout.write(
      `Workflow Id not provided. Using workflow '${workflow_id}'\n`
    );
  }
  // fetch all workflow runs on a given repo/branch/workflow with push and success
  const branches = await octokit
    .request(
      `GET /repos/${owner}/${repo}/actions/workflows/${workflow_id}/runs`,
      {
        owner,
        repo,
        // on non-push workflow runs we do not have branch property
        branch: lastSuccessfulEvent !== "push" ? undefined : branch,
        workflow_id,
        event: lastSuccessfulEvent,
        status: "success",
      }
    )
    .then(({ data: { workflow_runs } }) =>
      workflow_runs.map((run) => run.head_branch)
    );

  let uniqueBranches = [...new Set(branches)];

  process.stdout.write("\n");
  process.stdout.write(
    `uniqueBranches : ${uniqueBranches}\ntypeof uniqueBranches: `
  );
  process.stdout.write(typeof uniqueBranches);

  // Get the latest merge_commit from a closed
  let shas = [];
  for (const pr_branch of uniqueBranches) {
    process.stdout.write(`pr_branch: ${pr_branch}`);
    await octokit
      .request(`GET /repos/${owner}/${repo}/pulls`, {
        owner,
        repo,
        base: branch,
        head: `${owner}:${pr_branch}`,
        state: "closed",
        per_page: 1,
      })
      .then((pull_requests) => {
        process.stdout.write("\n");
        process.stdout.write(
          `Object.keys(pull_requests):${Object.keys(pull_requests)}`
        );
        process.stdout.write("\n");
        process.stdout.write(
          `Object.keys(pull_requests.data):${Object.keys(pull_requests.data)}`
        );
        process.stdout.write("\n");
        process.stdout.write(`typeof pull_requests.data:`);
        process.stdout.write(typeof pull_requests.data);

        pull_requests.data.map((pr) => {
          process.stdout.write(`map pr:${pr}`);
          process.stdout.write("\n");
          process.stdout.write(`pr: ${pr}\ntypeof pr: `);
          process.stdout.write(typeof pr);
          shas.push(pr.merge_commit_sha);
        });
      });
  }

  let uniqueShas = [...new Set(shas)];

  process.stdout.write("\n");
  process.stdout.write(`uniqueShas : ${uniqueShas}`);

  return findExistingCommit(uniqueShas, branch);
}

/**
 * Get first existing commit
 * @param {string[]} shas
 * @param {string} branchName
 * @returns {string?}
 */
function findExistingCommit(shas, branchName) {
  for (const commitSha of shas) {
    if (commitExists(commitSha, branchName)) {
      return commitSha;
    }
  }
  return undefined;
}

/**
 * Check if given commit is valid
 * @param {string} commitSha
 * @param {string} branchName
 * @returns {boolean}
 */
function commitExists(commitSha, branchName) {
  process.stderr.write("\n");
  process.stderr.write(`testing commit ${commitSha}`);
  try {
    // execSync(`git cat-file -e ${commitSha}`, { stdio: ["pipe", "pipe", null] });
    const output =
      execSync(`git branch -r --format '%(refname)' --contains ${commitSha}`, {
        stdio: ["pipe", "pipe", null],
      }) || "";
    process.stderr.write("\n");
    process.stderr.write(`typeof output:`);
    process.stderr.write(typeof output);
    const branches = output.split("\n");
    return (
      branches
        .filter((branch) => branch == `refs/remotes/origin/${branchName}`)
        .length() > 0
    );
  } catch (e) {
    process.stderr.write("\n");
    process.stderr.write("exception in commitExists");
    process.stderr.write(e.message);
    return false;
  }
}
