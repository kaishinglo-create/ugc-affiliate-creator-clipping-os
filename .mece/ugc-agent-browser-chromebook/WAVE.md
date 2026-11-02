# UGC Agent Browser Chromebook Wave

Conductor: ChatGPT
Executor: OpenCode
Status: BLOCKED

## Goal
Use a Chromebook (ChromeOS Linux/Crostini) as the external, self-hosted Chromium/Playwright browser host for the UGC system on Android/Termux.

## Current blocker
This OpenCode session runs only inside Android/Termux. It cannot inspect or configure the Chromebook directly. No Chromebook IP, hostname, SSH access, Crostini state, free memory, or reachable runtime port is available in this environment.

## Required manual gate
Before any implementation can be tested, confirm:
1. ChromeOS Linux (Crostini) is activated.
2. A reachable LAN IP or hostname for the Chromebook.
3. TCP connectivity from the Android phone to the chosen runtime port.
4. Node.js LTS, Playwright, and Chromium can be installed on the Chromebook.
5. Security approval for opening and protecting the runtime port.

No success claim is made here.
