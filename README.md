# laya-code-router

Routes each [Claude Code](https://code.claude.com/docs/en/setup) turn to the cheapest model that
can do it: Haiku for lookups, Sonnet for ordinary coding, Opus for hard work. It runs on **your own
Claude plan** (Pro or Max), uses no API key, and the routing decision is made by a small local
model ([LAYA](https://huggingface.co/convaiinnovations/laya)), so your prompt text goes nowhere
but your own machine.

It ships with a macOS menu-bar app that shows your plan usage, what each turn was routed to, and
what you saved against running everything on Opus.

Ported from [gargpratyush/jev-router](https://github.com/gargpratyush/jev-router) (MIT): the hosted
decision call is replaced with a local sidecar, and the app, installer and usage tracking are new.

## Install (macOS)

```bash
git clone https://github.com/SupremeDreamZ/laya-code-router ~/.laya-router/repo
bash ~/.laya-router/repo/setup.sh
```

Needs Node 20.12+, Python 3.10+, about 1.5 GB of disk, and Xcode's command-line tools for the
app (`xcode-select --install`). Setup checks all of it first and tells you what is missing.
It builds the model environment (a one-time download of about 1 GB), installs the menu-bar app,
starts the router, and registers it to start at login. Safe to run again.

```bash
./setup.sh --check       look at this Mac, change nothing
./setup.sh --cli-only    skip the menu-bar app (the launcher works alone, Linux included)
./setup.sh --uninstall   remove the app and the login item; your settings and usage stay
```

Then start a session with `laya-claude` instead of `claude`. It forwards every argument:

```bash
laya-claude
laya-claude --resume
laya-claude -p "fix the failing test"
```

Plain `claude` is not routed. Sign-in stays Claude Code's own: if you are signed out, the app says
so and `claude auth login` fixes it. Nothing here asks for your credentials.

## What it does

One routing decision per fresh user turn and per sub-agent, plus, if you turn it on, checks between
the steps of a tool loop. LAYA scores the prompt on three rubrics (task
complexity, reasoning required, tool complexity) and one judgment question; `src/policy.mjs` turns
the scores into a tier:

- an explicit request such as `use opus` or `use haiku` always wins;
- a mean score of 0.515 or more goes to **Opus**;
- below 0.48 with a judgment score under 0.45 goes to **Haiku**, and below 0.396 goes to Haiku
  whatever the judgment says;
- everything between goes to **Sonnet**;
- design work never goes to Haiku;
- within a session the tier only goes up, because Anthropic's prompt cache belongs to one model
  and a downgrade makes the next request start cold;
- a model you have switched off is skipped upward, never downward;
- Fable is off unless you turn it on.

If the routing model fails, is slow, or is not loaded, the turn goes on with the model it already
has. Routing never holds a prompt for more than 15 seconds (60 while the model is still loading).

### Sub-agents

A sub-agent is routed on its own. Its first request carries the task the main agent wrote for it;
LAYA scores that task and the sub-agent keeps the result for its whole tool loop. Its choice never
changes the main conversation's model. If LAYA cannot answer, the sub-agent runs on whatever the main
conversation is running on. Claude Code's background calls (titles, summaries) still go to Haiku.

### Step routing (off by default)

With step routing on, the router also checks in the middle of a tool loop, "between thoughts". Every
4th tool call of a turn (never two in a row) it asks LAYA about what the assistant is about to do: its
latest text and the names and arguments of its tool calls. It never sends the assistant's thinking or
the tool output.

- Moving up is allowed whenever LAYA is confident.
- Moving down throws away the prompt cache, so it also has to pay for itself: the saving over the
  next 6 steps, at the size of this conversation's steps so far, has to beat the cost of re-reading
  the context on the cheaper model, and the context has to be under 40,000 tokens.
- A turn where you named a model (`use opus`) is not checked.
- A switch the API could reject is refused and the reason recorded.

Turn it on per session with `LAYA_STEP_ROUTING=1 laya-claude ...`, which also works for headless
`-p` workers that share the app's router, or for every session with the setting `stepRouting: true`
(the app has no switch for it yet; the daemon accepts it through `prefs.update`). Every check is recorded in
the live feed (`~/.laya-router/events.jsonl`) as `class: "step"`, with LAYA's confidence, whether it
switched, and the estimated saving and cache rebuild, so you can see whether it pays.
`node test/live-step-routing.mjs` runs a short real session with it on.

### Presets

The app's preset moves the score cuts. **Balanced** is the numbers above. **Save most** raises the
Opus floor to 0.54 and the Haiku cuts to 0.50 / 0.416, so the same scores land cheaper. **Careful**
lowers them to 0.49 and 0.46 / 0.376. The judgment veto that keeps investigation and design work off
Haiku does not move. On the 58 labelled prompts, Save most sends 24 to Opus, Balanced 31, Careful 39,
and none sends hard work to Haiku.

### Pacing

Several sessions share one plan, and the 5-hour window is what stops them all. When it is 85% used
and resets more than 20 minutes from now, any new decision that would land on Opus (a turn, a
sub-agent or a step) gets Sonnet, with the reason `plan-pace-cap`. A conversation already on Opus
stays there, and a model you named or picked yourself is never capped. With no usage figure, nothing
is capped.

### Measured, not promised

The Haiku cut was fitted on 116 labelled prompts: 59% of Haiku-shaped work reaches Haiku, 30% of
Sonnet-shaped work is tried on Haiku first, and none of 37 Opus-shaped prompts is. It has not been
re-fitted since. LAYA's wide-choice head is uncalibrated, so only the score rubrics drive routing.

## The menu-bar app

- the plan's 5-hour and weekly usage, with reset times, and the figure beside the icon;
- the last decision and why, and a history of turns;
- what the turns would have cost at list prices against what they did, with the baseline
  (Opus by default) changeable in settings;
- usage alerts at levels you choose, when a limit is hit, and when it resets;
- how eagerly it saves (Save most, Balanced, Careful), which models it may use, and a one-click
  new session in the terminal of your choice.

Your plan does not bill per token, so the cost figure is what the same turns would have cost at
Anthropic's list prices. It is an estimate, and it says so.

The usage figure is read from Claude Code's own cache through `claude -p /usage`, which costs no
tokens and calls no model. That cache is undocumented and was checked on Claude Code 2.1.286 only;
if it changes the figure falls back to the rate-limit headers on routed turns, and the bar shows a
dash rather than a wrong number.

## Cost to run it

The routing model stays loaded so decisions are instant. Measured on an M2 Max: it loads in about
6 to 10 seconds, holds about **1.3 GB of memory** while the router runs, and a decision then takes
roughly 200 to 500 ms. Set `LAYA_EAGER_LOAD=0` to load it on the first prompt instead (the first
prompt then waits for the load, and memory is held only after that).

## Settings

Put these in `~/.laya-router.env` or the environment.

| Variable | Effect |
| --- | --- |
| `LAYA_PYTHON` | Python with the `laya` package (setup writes this). |
| `LAYA_EAGER_LOAD` | `0` loads the model on the first prompt instead of at start. |
| `LAYA_DEADLINE_MS` | Longest a prompt waits for a decision. Default 15000, 1 s to 10 min. |
| `LAYA_LOAD_DEADLINE_MS` | The same while the model is still loading. Default 60000. |
| `LAYA_LOAD_GIVE_UP_MS` | A model that never loads is replaced after this. Default 300000. |
| `LAYA_PLAN_TICK_MS` | How often usage is checked (default 5 min); `off` disables. |
| `LAYA_DISABLE_ROUTING` | `1` launches Claude Code untouched, with no proxy or model. |
| `LAYA_NO_DAEMON` | `1` keeps a session private even while the app runs. |
| `LAYA_MODEL` | Use a different LAYA checkpoint for every decision. |
| `LAYA_ALLOW_FABLE` | Enables the opt-in long tier when the app is not running. |
| `LAYA_STEP_ROUTING` | `1` turns on step routing for this session. |
| `LAYA_EVENTS_FILE` | Without the app, appends each routed request to this file as JSON. |
| `LAYA_DEBUG` | Logs decisions to `~/.laya-claude.log`. |

A value that is not a plain whole number in range is ignored and the default is used.

## How it fits together

```text
you -> laya-claude -> loopback proxy -> Anthropic
                         |
                         +-> LAYA sidecar (local, one Python process)
LayaBar.app <-> daemon (login item) -- settings, usage, history
```

`laya-claude` starts Claude Code with `ANTHROPIC_BASE_URL` pointed at a loopback proxy and the model
set to a sentinel, `laya-router`. The proxy forwards Claude Code's own authorization headers without
reading or storing them, picks the model for each fresh turn, and passes any model you chose yourself
straight through. The menu-bar app and the daemon are two processes on purpose: the daemon is the
router and outlives the app being closed.

## Limitations

- The app is macOS only. The command-line launcher also runs on Linux.
- Claude Code's request format is not a public contract; `LAYA_DUMP` helps diagnose a change.
- Tested against Claude Code 2.1.286 on macOS 26 (Apple silicon).
- The router also ships a Codex launcher (`laya-codex`); it is not covered by this guide.
- Light mode, and the sign-in button's browser hand-off, have not been checked.

## Development

```bash
npm install
npm test                                  # 747 tests, about 90 s
cd apps/LayaBar && swift test             # the app's tests
LAYA_PYTHON=~/.laya-router/venv/bin/python npm run live-routing   # real weights, no key
```

## License

MIT, inherited from [gargpratyush/jev-router](https://github.com/gargpratyush/jev-router).
