# Thin ACP host

One ACP Agent process and several ACP Clients that share its sessions. Air connects to it as an ordinary ACP Agent
(`~/.jetbrains/acp.json`), and a second Client, such as `watch.ts` or another IDE, joins the same session live.

```
 Air ──stdio── connect ─┐
                        ├── unix socket ── serve ──stdio── claude-agent-acp / codex-acp
 watch ─────────────────┘
```

The host has code only for the session lifecycle: `initialize`, `session/new|fork|resume|close` and
`session/prompt`. Everything about update variants and Agent-to-Client methods comes from the
[annotated schema](https://github.com/slapoguzov/acp-state-rows), the submodule `schema/`:

| Need | Without the schema data | With it |
|---|---|---|
| A Client joins a live session | Ask the Agent to replay, and the replay also goes to the Clients that already have it. Or keep raw updates, which breaks the replay rules (old `state_update`, old notices) | `session/resume` is answered from the host's store (`x-state`): history, `replay_complete`, current values, `state_update` last. The Agent is not asked |
| A permission request | Shown to one Client by a guess, or to everyone with no rule for the answer | `binding: "resource"`: shown to every Client of the session. The first answer wins, the others get `$/cancel_request` |
| A request about one Client's request (`elicitation/create` with `requestId`) | Goes to the Client of the session, which may be the wrong one | `/requests/{requestId}`: only the Client that sent that request, with its own request ID |
| `_auth/status_update`, which has no `sessionId` | Dropped: a host that routes by `sessionId` has nowhere to send it | `/`: every Client |
| A permission request carries a tool call | Code that copies it into the tool call | A row on the request: the tool call is stored, and a joining Client gets it |
| A new or custom update or method | Code for each one | A schema row, or the Agent's `capabilities.schema` in `initialize` |
| An Agent newer than the host's schema | A new host build and a restart, which also restarts the Agent | The host sets `capabilities.schema` in its upstream `initialize`. For each message it uses the Agent's row, else its own; with neither, the message is kept raw |

A Client that sets `capabilities.schema` in its own `initialize` gets the table the host uses: its own rows with the
Agent's rows over them.

## Files

| File | Lines | What it does |
|---|---|---|
| [`src/paths.ts`](src/paths.ts) | 37 | The path grammar shared by both keywords |
| [`src/state.ts`](src/state.ts) | 204 | `x-state`: one generic fold of session state, and the replay a joining Client gets |
| [`src/audience.ts`](src/audience.ts) | 37 | `x-audience`: the resource of an Agent-to-Client message |
| [`src/host.ts`](src/host.ts) | 263 | The host: connections, the session lifecycle, delivery by resource |
| [`src/jsonrpc.ts`](src/jsonrpc.ts) | 54 | Newline-delimited JSON-RPC over a child process or a socket, with `--trace` |
| [`src/main.ts`](src/main.ts) | 51 | `serve` (Agent, socket, `--trace`) and `connect` (stdio to socket, for Air) |
| [`src/watch.ts`](src/watch.ts) | 63 | A small terminal Client for the demo |

The rules are those of the internal document "Thin ACP host: behavior". Not supported: MCP over ACP (`/mcpServers`),
several users (`/` goes to every connection), and Client capabilities that differ between Clients (the first
`initialize` is sent to the Agent and every Client gets its result).

## Run

Node 22.18 or newer runs the TypeScript files directly. Clone with the schema:

```sh
git clone --recurse-submodules git@github.com:slapoguzov/acp-thin-host.git
```

```sh
npm test                                                     # 29 tests on a scripted Agent; the first run downloads the ACP schema
node src/main.ts serve --socket /tmp/acp-thin-host.sock \
  --agent-schema agent-schema/claude-codex.json -- npx -y @agentclientprotocol/claude-agent-acp
node src/watch.ts --socket /tmp/acp-thin-host.sock           # in another terminal
```

`agent-schema/claude-codex.json` is the `capabilities.schema` that the adapters would send in `initialize`: the
declaration of `_auth/status_update`. They send none yet, so the host adds it to its own rows; the Agent's rows,
when it sends them, are used first.

Air connects with `node src/main.ts connect --socket /tmp/acp-thin-host.sock` as an `agent_servers` entry of
`~/.jetbrains/acp.json`. The demo script is `plugins/air/acp-rfd/DEMO.md` in ultimate, branch
`a.slapoguzov/acp-state-audience-demo`.
