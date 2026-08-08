#!/bin/sh
# Run the dev servers under the newest nvm-installed Node (needs >= 20.19).
if [ -d "$HOME/.nvm/versions/node" ]; then
  latest=$(ls "$HOME/.nvm/versions/node" | sort -V | tail -1)
  export PATH="$HOME/.nvm/versions/node/$latest/bin:$PATH"
fi
cd "$(dirname "$0")/.."
exec npm run dev
