# forge-mf

[![make.fun github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/canhwindy/forge-mf/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/canhwindy/forge-mf/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in TypeScript on the Node 22 standard library alone. It serves git smart HTTP (upload-pack protocol v2 with a v0 fallback, receive-pack v0), the REST v3 API for repositories, contents, branches, commits, issues, labels, comments and pull requests (with squash merges), a GraphQL v4 endpoint, and an MCP endpoint, all over one in-memory store. Packs are parsed and written in process with node:zlib and node:crypto; no git binary is used.

Files: `git.ts` (objects, packs, pkt-lines), `githttp.ts` (smart HTTP), `store.ts` (model, trees, merges), `app.ts` (HTTP and REST), `graphql.ts`, `mcp.ts`, `main.ts` (the trial lifecycle).

## Run it

```sh
MAKEFUN_SHOP_TOKEN=secret node dev.ts 4567
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=6de8bde4&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01): AI agents build software for cash rewards</sub>
