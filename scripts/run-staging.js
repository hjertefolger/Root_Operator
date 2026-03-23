const { spawnSync } = require('child_process');

const targetScript = process.argv[2];

if (!targetScript) {
  console.error('Usage: node scripts/run-staging.js <npm-script>');
  process.exit(1);
}

const env = {
  ...process.env,
  UPDATE_REPO_OWNER: process.env.UPDATE_REPO_OWNER || 'hjertefolger',
  UPDATE_REPO_NAME: process.env.UPDATE_REPO_NAME || 'Root_Operator_Staging',
  UPDATE_RELEASE_TYPE: process.env.UPDATE_RELEASE_TYPE || 'prerelease',
  UPDATE_PRIVATE: process.env.UPDATE_PRIVATE || 'false',
};

if (targetScript === 'release' && !env.GH_TOKEN && !env.GITHUB_TOKEN) {
  const token = spawnSync('gh', ['auth', 'token'], {
    encoding: 'utf8',
  });

  if (token.status !== 0 || !token.stdout.trim()) {
    console.error('Failed to obtain GH_TOKEN from gh auth token.');
    console.error('Log in with gh auth login or export GH_TOKEN manually.');
    process.exit(token.status || 1);
  }

  env.GH_TOKEN = token.stdout.trim();
}

const child = spawnSync('npm', ['run', targetScript], {
  stdio: 'inherit',
  env,
});

process.exit(child.status || 0);
