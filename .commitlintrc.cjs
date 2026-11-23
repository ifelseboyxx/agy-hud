const scopes = ['root', 'hud', 'collectors', 'render', 'cli', 'skills', 'scripts', 'tests', 'docs', 'deps'];

module.exports = {
  rules: {
    'header-max-length': [2, 'always', 108],
    'subject-empty': [2, 'never'],
    'subject-case': [0],
    'type-empty': [2, 'never'],
    'scope-empty': [2, 'never'],
    'scope-enum': [2, 'always', scopes],
    'type-enum': [
      2,
      'always',
      [
        'init',
        'feat',
        'fix',
        'docs',
        'style',
        'refactor',
        'perf',
        'test',
        'build',
        'ci',
        'revert',
        'chore',
        'deps',
        'release',
      ],
    ],
  },
  prompt: {
    useEmoji: false,
    useAI: false,
    scopes,
    allowCustomScopes: false,
    allowEmptyScopes: false,
  },
};
