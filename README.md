<p align="center">
  <img src=".github/logo.webp" width="96" alt="" />
</p>

<h1 align="center">Fleet</h1>

<p align="center">
  <b>Run a fleet of coding agents from one quiet console.</b><br/>
  Hand work to Commodores, let their Commanders and members carry it out on every frontier model,<br/>
  and stay in charge from the desktop or your phone.
</p>

<p align="center">
  <a href="https://github.com/sbluemin/fleet-harness/releases/latest"><img src="https://img.shields.io/github/v/release/sbluemin/fleet-harness?style=flat-square&color=c9a455&label=release" alt="Latest release"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-5c9e92?style=flat-square" alt="MIT license"></a>
  <a href="https://sbluemin.github.io/fleet-harness/"><img src="https://img.shields.io/badge/site-sbluemin.github.io-2b2f38?style=flat-square" alt="Project site"></a>
</p>

<p align="center">
  <b>English</b> · <a href="README.ko.md">한국어</a>
</p>

<img src=".github/commodore.webp" alt="Fleet Console Desktop: the Commodore Atlas opens an objective from a one-line request, approves its criteria and commences it, while the sidebar lists Commodores, objectives and a TaskForce" width="100%" />

## Start

```bash
npm i -g https://github.com/sbluemin/fleet-harness/releases/latest/download/fleet-console.tgz
fleet console
```

`fleet console` starts a local server and prints its address; open it in any browser. You need Node.js 20.19 or later and Claude Code installed and signed in. Update from the Console or with `fleet update`.

## What makes Fleet different

**Commodores run the work.** A Commodore is a standing coordinator you create, with its own project folders (Theaters), memory and routines. Tell it what you need; it opens objectives, reviews their plans, approves criteria, commences them, and brings you only the decisions it should not make.

**Objectives finish without you babysitting them.** Each objective has a Commander that lays out missions, proposes success criteria and delegates to members, each on its own model and effort. Work moves from plan to approval to commencement, and comes back with a retrospective.

<img src=".github/objective.webp" alt="An objective's missions: the Commander on Opus, an implementer on Sonnet and a reviewer on Fable, with four missions in a line and the first one done" width="100%" />

**TaskForce lets Commodores decide together.** Put several Commodores in one room. Each answers from its own Theaters, you steer, and the conclusion becomes objectives right there.

<img src=".github/taskforce.webp" alt="A TaskForce named Release 0.5: Atlas, Vega and Orion each weigh in, the person agrees, and Vega opens a docs objective from the discussion" width="100%" />

**Every frontier model, behind Claude Code.** The AI Gateway runs Claude Code's own agent loop on Codex, Gemini (Antigravity), Grok (xAI) and Muse Code models with the subscriptions you already have. Their credentials stay in the Console. When Commodores and Commanders pick models, they choose from the ones you turned on, ordered by remaining quota.

**A browser you share with your agents.** In the desktop app, Fleet Browser opens beside the conversation or in its own window. Agents work in their own spaces on the same tabs and sign-ins, and you can annotate a page to hand it to them.

**Sessions live on your machine, not in the tab.** Close the page, restart the browser, or switch devices; the work keeps running. Use the desktop app for macOS and Windows, pair a phone or another computer through remote access, or use the Android and iOS apps in tester distribution.

<p align="center"><img src=".github/mobile.webp" alt="Fleet on a phone: the Commodore Atlas reporting that it approved the criteria and commenced the objective" width="320" /></p>

## Local by default

The server listens only on loopback until you turn on remote access, which pairs devices with one-use links that expire in 15 minutes. Sessions, settings and history stay under `~/.fleet`.

## Go deeper

- [Desktop guide](runtime/fleet-desktop/README.md)
- [Fleet Development Reference](docs/fleet-development-reference.md)
- [Changelog](CHANGELOG.md)

<sub>Screenshots come from an isolated demo Console with sample data.</sub>

## License

[MIT](LICENSE)
