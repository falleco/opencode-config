apt install -y ripgrep
# Beads
curl -fsSL https://raw.githubusercontent.com/steveyegge/beads/main/scripts/install.sh | bash

# Node
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
nvm install 24
# Verify the Node.js version:
node -v # Should print "v24.13.0".
# Verify npm version:
npm -v # Should print "11.6.2".