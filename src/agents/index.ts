/**
 * Built-in Agents — ready to use out of the box.
 */

export { writer } from './writer.js';
export { researcher } from './researcher.js';
export { critic } from './critic.js';
export { analyst } from './analyst.js';
export { investigator } from './investigator.js';
export { investigatorCritic } from './investigator-critic.js';
export { marketing } from './marketing.js';
export { blogWriter } from './blog-writer.js';

import { writer } from './writer.js';
import { researcher } from './researcher.js';
import { critic } from './critic.js';
import { analyst } from './analyst.js';
import { investigator } from './investigator.js';
import { investigatorCritic } from './investigator-critic.js';
import { marketing } from './marketing.js';
import { blogWriter } from './blog-writer.js';
import type { AgentDefinition } from '../types.js';

/** All built-in agents by name */
export const builtinAgents: Record<string, AgentDefinition> = {
  writer,
  researcher,
  critic,
  analyst,
  investigator,
  'investigator-critic': investigatorCritic,
  marketing,
  'blog-writer': blogWriter,
};
