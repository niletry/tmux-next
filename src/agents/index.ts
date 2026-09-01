/**
 * The coding agents this app can start, and what it knows about each.
 *
 * tmux-next began as a Claude Code viewer, but nothing in the terminal path is
 * specific to it — capture-pane and send-keys do not care what runs inside. The
 * agent-specific parts are narrow and separable: how to launch, how to resume,
 * where the transcript lives, and what its TUI chrome looks like on screen.
 *
 * Capabilities are optional by design. opencode keeps sessions in SQLite while
 * the other two use JSONL; only Claude Code exposes external hooks. An agent
 * that cannot do something leaves the field undefined and callers degrade —
 * a session with no `readTask` simply shows no task line, which is not an error.
 *
 * THE INVARIANT: a launch command is a constant. Nothing derived from a request
 * is ever interpolated into one, because these strings reach `sh -c`. An agent
 * is selected by looking up this table by id; the id itself never appears in a
 * command. Resume ids are the single caller-supplied value that reaches a
 * command string, and they are admitted only after matching the id pattern
 * declared for that agent below.
 */

/** Id-safe characters only — uuids and the like, nothing shell-shaped. */
import { readPiTask } from "./pi";
import { readOpencodeTask } from "./opencode";
import { readLastPrompt, transcriptPath } from "../claude-activity";
import { readLastAction, type LastAction } from "./last-action";
import { readTurnState, type TurnState } from "./turn-state";

/**
 * Per-agent session id shapes.
 *
 * Not one shared pattern: real ids differ. Claude Code and pi write uuids
 * (`0edc8e4f-f7fe-…`), while opencode writes `ses_05d709e3cffehI0t7IvoOR0zjb` —
 * underscore and mixed case. A single uuid-only rule silently refused every
 * opencode resume, which is how this was found.
 *
 * Each stays anchored and limited to characters inert in a shell. Widening one
 * is a security decision, not a formatting one: the id is the only
 * caller-supplied value that ever reaches a command string.
 */
const UUID_ID = /^[A-Za-z0-9-]{1,64}$/;
const OPENCODE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type LaunchOptions = { skipPermissions: boolean };

export type Agent = {
  id: string;
  label: string;

  /** The latest thing this conversation was asked to do, if reachable. */
  readTask?: (cwd: string, id: string) => Promise<string | null>;

  /**
   * The most recent thing this conversation actually did, if reachable.
   *
   * Only agents whose transcript records tool calls can answer this; the others
   * leave it undefined and the card falls back to the screen-diff timestamp,
   * which is what every session had before.
   */
  readLastAction?: (cwd: string, id: string) => Promise<LastAction | null>;
  /**
   * 这个会话是在跑还是在等你，从 transcript 的结构里读，而不是认屏幕。
   *
   * 只有 Claude 有：opencode / pi 的记录格式不同。没有这一项的 agent 继续走屏幕
   * 启发式，那条路不会被删——没有 transcript 的会话（早于绑定记录、或者里面跑的
   * 根本不是 agent）只有屏幕这一个信息源。
   */
  readTurnState?: (cwd: string, id: string) => Promise<TurnState | null>;

  /**
   * Whether this agent has a "run without asking" mode.
   *
   * Only Claude Code does. opencode has no such flag at all, and pi's
   * `--approve` means something else entirely (trusting project-local config,
   * not skipping tool confirmation) — so it is not wired to this. The picker
   * hides the checkbox where this is false rather than offering a switch that
   * would do nothing.
   */
  supportsSkipPermissions: boolean;

  /** The command that starts a fresh conversation. Always a constant. */
  launch(opts: LaunchOptions): string;

  /** The command that continues an existing one, or null if the id is unusable. */
  resume?: (id: string, opts: LaunchOptions) => string | null;

  /**
   * How this agent's TUI paints, so the session list can tell content from
   * decoration and spot a finished turn.
   */
  screen: {
    /** Lines that carry no information and should not reach the preview. */
    chrome: RegExp[];
    /** Printed when a turn ends and the agent is waiting on the user. */
    idleMarker: RegExp;
  };
};

/** Box drawing, which every one of these TUIs uses for its frame. */
const BOX_ONLY = /^[\s─│╭╮╰╯━┃┏┓┗┛|]*$/;

const claude: Agent = {
  id: "claude",
  label: "Claude Code",
  supportsSkipPermissions: true,
  readTask: (cwd, id) => readLastPrompt(transcriptPath(cwd, id)),
  readLastAction,
  readTurnState,
  launch: ({ skipPermissions }) =>
    skipPermissions
      ? 'exec "$SHELL" -lc "claude --dangerously-skip-permissions"'
      : 'exec "$SHELL" -lc claude',
  resume: (id, { skipPermissions }) => {
    if (!UUID_ID.test(id)) return null;
    const flags = skipPermissions ? " --dangerously-skip-permissions" : "";
    return `exec "$SHELL" -lc "claude --resume ${id}${flags}"`;
  },
  screen: {
    chrome: [
      BOX_ONLY,
      /bypass permissions/,
      /enter to collapse/,
      /new task\? \/clear/,
      /^\s*\/rc\s*$/,
      /\? for shortcuts/,
    ],
    // e.g. "✻ Cogitated for 1m 21s"
    idleMarker: /^\s*[✻✽✢·*]\s+\S+ for \d/,
  },
};

const opencode: Agent = {
  id: "opencode",
  label: "opencode",
  supportsSkipPermissions: false,
  readTask: (cwd, id) => readOpencodeTask(cwd, id),
  launch: () => 'exec "$SHELL" -lc opencode',
  resume: (id, _opts) => {
    if (!OPENCODE_ID.test(id)) return null;
    return `exec "$SHELL" -lc "opencode --session ${id}"`;
  },
  screen: {
    chrome: [BOX_ONLY, /^\s*\/help\s*$/, /esc to interrupt/i],
    idleMarker: /^\s*(?:>|❯)\s*$/,
  },
};

const pi: Agent = {
  id: "pi",
  label: "pi",
  supportsSkipPermissions: false,
  readTask: (cwd, id) => readPiTask(cwd, id),
  launch: () => 'exec "$SHELL" -lc pi',
  resume: (id, _opts) => {
    if (!UUID_ID.test(id)) return null;
    return `exec "$SHELL" -lc "pi --session ${id}"`;
  },
  screen: {
    chrome: [BOX_ONLY, /ctrl\+c to (?:quit|interrupt)/i],
    idleMarker: /^\s*(?:>|❯)\s*$/,
  },
};

export const AGENTS: Record<string, Agent> = { claude, opencode, pi };

/** Display order for the picker; explicit rather than relying on key order. */
export const AGENT_IDS = ["claude", "opencode", "pi"] as const;

export const DEFAULT_AGENT = "claude";

/**
 * Whether a value names an agent we ship.
 *
 * `Object.hasOwn` rather than a truthiness check on the lookup, so inherited
 * names like `toString` cannot pass as agents.
 */
export function isKnownAgent(id: unknown): id is string {
  return typeof id === "string" && Object.hasOwn(AGENTS, id);
}

/**
 * An agent by id, falling back to the default.
 *
 * Total on purpose: the id arrives from a request and from disk, and a stale or
 * removed one should degrade to the default rather than break a page load.
 */
export function agentOf(id: unknown): Agent {
  return isKnownAgent(id) ? AGENTS[id]! : AGENTS[DEFAULT_AGENT]!;
}
