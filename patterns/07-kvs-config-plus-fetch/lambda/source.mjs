// Stand-in for the source of truth (your config service or database): every valid key has a config.
const CONFIGS = {
  acme: { plan: 'enterprise', model: 'large', rateLimit: 1000 },
  globex: { plan: 'pro', model: 'medium', rateLimit: 100 },
};

export const lookup = (key) => CONFIGS[key] ?? { plan: 'free', model: 'small', rateLimit: 10 };
