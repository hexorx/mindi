import config from '@mindi/eslint-config';

export default [...config, { languageOptions: { globals: { console: 'readonly' } } }];
