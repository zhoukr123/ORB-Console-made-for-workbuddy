<div align="center">

# ORB Console

**A desktop AI agent that actually operates your PC.**

Say one sentence. It screenshots your screen, figures out where to click, and clicks / types / scrolls for you —
then reports the whole run back to the chat panel. A floating orb stays on your desktop; it gets out of the way when idle.

[简体中文](README.md) · [Download](#download) · [Roadmap](ROADMAP.md)

![platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-0078D6)
![license](https://img.shields.io/badge/license-MIT-brightgreen)
![release](https://img.shields.io/github/v/release/zhoukr123/ORB-Console-made-for-workbuddy)
![stars](https://img.shields.io/github/stars/zhoukr123/ORB-Console-made-for-workbuddy)

</div>

![ORB Console: the main panel](docs/hero.gif)

---

## Safety first

Handing your mouse to an AI raises one question before any other: *what if it goes rogue?* ORB treats that as a first-class feature:

| Mechanism | Detail |
| --- | --- |
| **Emergency stop** | `Ctrl + Alt + Backspace`, or the red stop button in the top bar. Interrupts mid-action, nothing keeps running in the background |
| **Permission tiers** | Read-only / Workspace-writable / Full access. Persisted per session. No vision loop unless you grant full access |
| **Observation border** | The target window lights up with a border while a foreground action runs, so you always see *what* is being operated |
| **Human confirmation** | Irreversible actions (delete, pay, send) must raise a confirmation first |
| **Token auth** | Every bridge endpoint requires a `X-Orb-Token` generated at process start. No random web page can drive your PC |
| **No telemetry** | None. Keys stay in memory — never written to disk or logs |

---

## Three execution tracks

One sentence in, ORB picks the track — or you force one manually.

| Track | What it does | Good for |
| --- | --- | --- |
| **Foreground** | Drives your PC directly: click, type, hotkeys, scroll, press-and-hold, drag, screenshot | Launching apps, filling forms, tidying files |
| **Background** | Dispatches heavy work to a local agent (headless, one-shot), results stream back | Reading a codebase, writing long documents, batch jobs |
| **Vision** | A `screenshot → vision model → action → screenshot` loop; the model decides the next click itself | Apps with no API that you can only drive by looking |

Vision coordinates use **per-mille (0–1000)** instead of pixels, so high-DPI screens don't make the model miscount;
it can `zoom` / `reset` the viewport on its own, and falls back to a secondary model when the primary fails.

---

## Download

| Option | Size | Notes |
| --- | --- | --- |
| **Portable single-file `.exe`** | ~208 MB | Grab `ORB-Console-<version>-portable.exe` from [Releases](https://github.com/zhoukr123/ORB-Console-made-for-workbuddy/releases) and double-click |
| **Portable `.zip`** | ~208 MB | Same release; unzip and run the launcher inside |
| **Run from source** | — | Requires Node.js 22+, see below |

The portable build is a **self-extracting single file**: it unpacks itself to `%LOCALAPPDATA%\ORBConsole` and starts.
No installer, no registry writes, no need for a pre-installed Node or Python (runtimes ship inside).

- Data directory: `%APPDATA%\ORB 控制台`
- Uninstall: run `uninstall-ORB-Console.cmd` next to it
- SmartScreen may warn on first run — choose "More info → Run anyway" (no signing certificate yet)
- GitHub forces ASCII asset names; the Chinese names appear in each asset's description text

### Run from source

```bat
:: Requires Windows 10/11 x64 and Node.js 22+
npm install --prefix orb
npm install --prefix orb/desktop

:: then launch
双击 "启动 ORB 控制台.cmd"
```

---

## Features

| Feature | Detail |
| --- | --- |
| Floating orb | Always on top; hover to expand, click to pin, drag to reposition (remembered), drag off-screen to dock as a thin tab |
| Conversational control | Input is auto-routed to foreground / background, or you pick |
| Select-to-act | Select any text and a toolbar pops up (search / translate / send to agent) — no global keyboard hook |
| Voice input | Streaming transcription from the mic button. Pluggable engine: browser Web Speech or your own Whisper endpoint |
| Vision loop | Per-mille coordinates + active zoom + automatic model fallback |
| Screen recording | Native MP4 output (1080p / 30fps) with a floating control bar: pause / resume / cancel / finish (v1.2.0) |
| Screenshot | Invokes your local Snipaste for selection and annotation, archives into your storage folder (v1.2.0) |
| Workflow recording | Record a sequence from the top bar; while recording that button turns into a red square (finish). Replay and edit it under Settings › Screenshot & Recording › Workflow (v1.3.6) |
| Feature lookup | `Ctrl + K` now searches features only — workflows and chat history have their own homes instead of sharing one search box (v1.3.6) |
| Workflow: when things change | Every workflow gets a goal and an "if something looks wrong" policy: keep going by coordinates / stop and report / ask the vision model once / hand a few steps to the agent. The last two only fire on steps that have an anchor and where that anchor is genuinely gone — every other step stays pure replay (v1.4.0) |
| Smart takeover | If replay loses its target, the vision model drives a small batch of actions to get back on track. The backend decides (it re-screenshots and OCRs to check); inside loops it tells the model which round it is, so rounds are never silently skipped (v1.4.0) |
| Loop round marker | Mark the action that runs once per round; if the UI slips, the audit log counts how many times it succeeded to infer completed rounds (v1.4.0) |
| Repeat folding | If a recording contains near-identical segments, you get one line of explanation and a "fold into a loop" button. It never restructures your workflow on its own (v1.4.0) |
| Inline triggers | Interval / file-change / hotkey triggers live at the bottom of each workflow's editor — enable, disable, delete in place (v1.4.0) |
| Workflow list & audit | Replay / edit / delete are now icon buttons; delete asks you to type a confirmation. The audit log moved into Settings › Storage (v1.4.0) |
| Five personas | Gentle Guardian / Genki Cheer / Comrade / Guide / Tsundere — each with its own lines, tone, kaomoji and voice. Pick one under Settings › Persona. Sunshine and Joker were merged in v1.5.0; old configs migrate automatically (v1.5.0) |
| AI lines | One extra model call per task generates the whole round (three progress lines + one success + one failure), released against real progress. Progress lines only name the kind of action, never file names — facts come from the program, wording from the model. Any failure silently falls back to canned lines (v1.5.0) |
| Custom line model | Point it at your own OpenAI-compatible endpoint for persona lines. The key stays on this machine and reads back masked; a "Test" button fires a real request. Background tasks still run on the CLI — a text endpoint cannot replace its tool orchestration (v1.5.0) |
| Orb behaviour | Seven GIFs (done / greet / loading / nod / shy / think / goodnight), each with its own trigger; toggle all or individually. Idle for two minutes and it plays one at random (v1.4.0) |
| Persona speech bubbles | Each spoken line now also appears as a small bubble in the chat (muted, tinted with the theme accent). It shows even with sound off — previously the lines were audio-only and never displayed (v1.4.0) |
| Lean narration | By default it only speaks on outcomes and moods (done / fail / praised / milestones / late night / sedentary), skipping "received" and "working". Switch back to full under Settings › Persona › Voice (v1.4.0) |
| Four themes | Deep Space / Daylight / Aurora / Custom gradient; frosted glass available on Deep Space and Custom |

### Workflows: recorded once, still working after the UI moves (v1.4.0)

The hard part of replay isn't recording — it's that buttons move and dialogs appear later. Every workflow now carries a
**goal** and an **"if something looks wrong"** policy with four choices: keep going by coordinates, stop and report,
ask the vision model once, or hand a few steps to the agent. The last two only trigger on steps that have an anchor
and where that anchor is genuinely missing, so nothing else gets slower.

Also in this release: an optional **round marker** on loops (the audit log counts how many times the marker action
succeeded, to infer completed rounds), a **fold-into-loop suggestion** after recording (offered, never applied
silently), and interval / file / hotkey triggers managed inline in each workflow's editor.

### Personas: five characters, and their lines (v1.4.0 / v1.5.0)

Personality is a **companion layer**, kept separate from what the AI answers — it never rewrites the model's reply,
it just mutters alongside. Choose one under **Settings › Persona**: Gentle Guardian, Genki Cheer, Comrade,
Guide or Tsundere, each with its own line library, tone, kaomoji and voice; the floating orb's seven GIFs act
along with it.

Spoken lines now **show up in the chat** as a small bubble (one size smaller, muted, with a thin accent rule) —
they work with sound off, which they never did before. **Lean narration** is on by default: one line per task at
outcome moments (done, failed, praised) instead of "received → working → done".

> Sunshine and Joker were merged into **Genki Cheer** in v1.5.0 — their language parameters were nearly identical,
> so keeping them apart only produced two look-alike characters. Existing configs migrate automatically.

### AI lines: improvised, but not made up (v1.5.0)

Turn on **Settings › Persona › AI lines** (off by default) and each dispatched task costs **one extra model call**,
which generates the whole round at once: three progress lines, one success line, one failure line. That is the
cost of a single call, yet the entire run speaks in this persona's own words.

The division of labour is strict: **the program decides when to speak, how many lines in, and which kind of action
is happening — the model only decides the wording.** Tool names map to generic actions (reading/searching files =
digging through boxes, editing = picking up a pen, running commands = turning a screw; anything unrecognised stays
silent). So it would rather say one line less than invent a filename. At most three lines, never the same tool
twice, at least six seconds apart.

Any failure (no endpoint, endpoint down, timeout, unparsable output) silently falls back to the canned lines —
you see the old behaviour. Switch it off and no extra call happens at all.

To make it faster and keep CLI credits untouched, fill in your own OpenAI-compatible endpoint under
**Settings › Channels › Background Agent › Line model**. That one only decides *how the line is worded*; it does not
take over background tasks — those need the CLI's tool orchestration.

> The Persona › Memory option currently only stores your choice; reading the actual memory files is not wired up yet.

---

## Third-party components

This repo ships **only its own source, docs and build scripts** — no third-party proprietary software:

- **WorkBuddy / CodeBuddy Code CLI** (Tencent, proprietary) is *not* bundled. The background track calls the CLI you installed yourself.
- Selection, screenshot and window operations come from MCP services you installed yourself.
- The screenshot feature invokes **Snipaste** if you have it installed; ORB only detects, invokes and archives.
- See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

> "ORB" refers to the floating-orb form factor. This project is **not affiliated** with DeepSeek Orb or any other
> same-named product, nor with Tencent WorkBuddy / CodeBuddy — it is an independent third-party project.

---

## About the icon

The app icon is a **rounded blue square with a white graphic**, the project's own visual identity:

- it uses no graphic elements from any third-party product;
- rounded squares and blue/white palettes are **generic visual language** (not protected by copyright),
  used only to stay visually consistent with the ecosystem this project lives in;
- source renders in [`docs/icon/`](docs/icon/) (1024 / 512 / 256 / 64).

---

## Contributing

Issues and PRs are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md) first; security reports go to [SECURITY.md](SECURITY.md);
what's next lives in [ROADMAP.md](ROADMAP.md).

---

## License

[MIT](LICENSE)
