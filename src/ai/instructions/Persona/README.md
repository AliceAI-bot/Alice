# Personas

This release ships `default.txt` only. It fully defines Alice for self-hosters.

Other personas (`evil.txt`, `girlfriend.txt`) are private and intentionally
unreleased — they stay gitignored and are not required to run the bot.

Fresh clone checklist:
- `src/ai/instructions/Persona/default.txt` must exist (it does in this release).
- `/chat` autocomplete lists whatever `*.txt` files are present here.
- DMs and mentions fall back to the `default` persona.
