# Simplify3x Connect

Work with [SimplifyQA](https://simplifyqa.ai) test management and automation from Claude, in plain
language. Find projects and test cases, write and edit test cases, run them, and triage failed
executions and defects.

## What you need

- A **SimplifyQA account**, your **SimplifyQA URL** and an **API token** from your SimplifyQA profile.
- **Node.js 20 or later** on your computer.
- Optional: the **SimplifyQA desktop agent**, only if you want to record new test cases live.

## Install

```
/plugin install simplify3x-connect --marketplace Simplify3x/simplify3x-connect
```

During setup, Claude asks for:

| Setting | Required | What to enter |
|---|:---:|---|
| SimplifyQA URL | Yes | Your SimplifyQA workspace URL, for example `https://app.simplifyqa.ai` |
| API token | Yes | The API token from your SimplifyQA profile. It is stored as a secret. |
| Default project ID | No | The project to use when you don't name one. You can switch projects in chat. |
| Local agent URL | No | Only for live recording, for example `http://127.0.0.1:4050/mcp` |

## Try it

- "List my SimplifyQA projects and switch to Payments"
- "Find the test cases for the login flow"
- "Run TC_123 and show me the result"
- "Why did yesterday's regression suite fail? Summarise the failures"
- "Create a test case that checks a user can reset their password"

## What this plugin runs, sends and fetches

- **Runs:** the open-source MCP server
  [`simplify3x-connect@0.31.9`](https://www.npmjs.com/package/simplify3x-connect), started on your
  computer with `npx`. The first start downloads it and its dependencies from the npm registry. It
  needs Node.js 20 or later. Source code: https://github.com/Simplify3x/simplify3x-connect
- **Sends:** requests only to the **SimplifyQA URL you enter**, authenticated with your API token,
  and, if you set it, to your **local SimplifyQA agent** for recording. Nothing else.
- **Fetches:** your SimplifyQA projects, test cases, suites, executions, defects and related data
  from that same SimplifyQA URL, in answer to your requests.
- **No telemetry:** the plugin sends no usage data or analytics to Simplify3x or anyone else, and
  contacts no other hosts.

Some tools change data in SimplifyQA, such as creating or updating test cases or starting a run.
They act with your API token, so they can do only what your SimplifyQA account is allowed to do.

## Privacy, terms and support

- Privacy policy: https://simplifyqa.ai/privacy
- Terms: https://docs.simplifyqa.ai/legal-documents/end-user-license-agreement
- Support: https://docs.simplifyqa.ai/need-support-connect-with-us

Licensed under the MIT License.
