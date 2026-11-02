set -euo pipefail
cd /data/data/com.termux/files/home/ugc
mkdir -p .mece/cells/CELL-01 .mece/cells/CELL-02 .mece/cells/CELL-03 .mece/cells/CELL-04
cat > .mece/WAVE.md <<'EOF'
# MECE WAVE 02

Goal: Full audit, autonomous repair, regression testing.

Execution: Sequential, one OpenCode session per cell.

Rules: Preserve user changes, no secrets exposure, no destructive
production actions, no unapproved paid services.

Read .mece/AUDIT.md before work if present.
EOF
cat > .mece/cells/CELL-01/TASK.md <<'EOF'
# CELL-01 — Frontend and Browser

Own frontend UI and browser test infrastructure.
Inspect the existing app and initial audit.
Install/use Playwright only if appropriate and available.
Test routes, navigation, buttons, forms, validation,
console errors, responsive desktop/tablet/mobile.
Fix confirmed frontend defects.
Do not modify backend integration or routing/security ownership.
Do not overwrite unrelated user changes.
Run frontend tests and browser regression tests.
Write REPORT.md with changes, evidence, tests, blockers and risks.
EOF
cat > .mece/cells/CELL-02/TASK.md <<'EOF'
# CELL-02 — Ollama and API Integration

Own Ollama integration and provider registration.
Reproduce HTTP 402 safely. Inspect server-side configuration,
error handling, provider discovery and chat request flow.
Determine whether 402 is billing, model availability,
configuration or application behavior.
Fix application-side defects. Never purchase credits,
change subscriptions or expose API keys.
Never print secret values.
Run API tests and integration regression tests.
Do not modify frontend UI or general routing/security.
Write REPORT.md with evidence and verification.
EOF
cat > .mece/cells/CELL-03/TASK.md <<'EOF'
# CELL-03 — Routing and Security

Own server routing, SPA fallback and authorization.
Inspect unknown paths, static file handling, API 404 behavior,
workspace authorization and file access.
Test unauthenticated and unauthorized access safely.
Fix confirmed application defects.
Do not weaken authentication or authorization.
Do not modify Ollama integration or frontend ownership.
Run routing and security regression tests.
Write REPORT.md with evidence and verification.
EOF
cat > .mece/cells/CELL-04/TASK.md <<'EOF'
# CELL-04 — Final Regression and Synthesis

Run only after CELL-01, CELL-02 and CELL-03 reports exist.
Read all three reports and the original audit.
Inspect git diff and test results.
Run the complete available test suite and regression checks.
Identify unresolved failures, conflicts and untested behavior.
Do not blindly overwrite or revert changes.
Write .mece/SYNTHESIS.md with:
- verified working functionality
- repaired defects
- remaining defects and severity
- test evidence
- regression results
- human decisions still required
Write this cell's REPORT.md.
EOF
echo "=== WAVE 02: CELL 01 ==="
opencode run --dir . "$(cat .mece/cells/CELL-01/TASK.md)When finished, write .mece/cells/CELL-01/REPORT.md."
echo "=== WAVE 02: CELL 02 ==="
opencode run --dir . "$(cat .mece/cells/CELL-02/TASK.md)When finished, write .mece/cells/CELL-02/REPORT.md."
echo "=== WAVE 02: CELL 03 ==="
opencode run --dir . "$(cat .mece/cells/CELL-03/TASK.md)When finished, write .mece/cells/CELL-03/REPORT.md."
echo "=== WAVE 02: CELL 04 ==="
opencode run --dir . "$(cat .mece/cells/CELL-04/TASK.md)When finished, write .mece/cells/CELL-04/REPORT.md."
echo "=== WAVE 02 STATUS ==="
for f in .mece/cells/*/REPORT.md .mece/SYNTHESIS.md; do
  if [ -f "$f" ]; then echo "DONE: $f"; else echo "PENDING: $f"; fi
done