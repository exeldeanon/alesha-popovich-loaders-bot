import {fileURLToPath} from 'node:url';

// The three approved illustrations are reused by semantic section rather than
// repeated on every individual item. This keeps the bot warm and visual while
// avoiding a noisy media-heavy feed.
export const VISUALS = Object.freeze({
  welcome: fileURLToPath(new URL('./assets/welcome-loader.png', import.meta.url)),
  orders: fileURLToPath(new URL('./assets/team-movers.png', import.meta.url)),
  work: fileURLToPath(new URL('./assets/team-movers.png', import.meta.url)),
  cabinet: fileURLToPath(new URL('./assets/welcome-loader.png', import.meta.url)),
  settings: fileURLToPath(new URL('./assets/moving-kit.png', import.meta.url)),
  manager: fileURLToPath(new URL('./assets/moving-kit.png', import.meta.url)),
});

export const visualPath=(name)=>VISUALS[name]||VISUALS.welcome;
