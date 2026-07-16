import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runMultiCritic, getCriticPrompts, stripMarkdownForJudging } from '../src/evolution/multi-critic.js';
import type { CriticPromptDef, RunCriticFn } from '../src/evolution/multi-critic.js';

describe('runMultiCritic', () => {
  it('passes criticName to RunCriticFn callback', async () => {
    const receivedNames: string[] = [];

    const mockCritic: RunCriticFn = async (_prompt, _task, criticName) => {
      receivedNames.push(criticName);
      return '===SCORE===\n8\n===ASSESSMENT===\nGood.\n===END===';
    };

    await runMultiCritic('test output', 'test task', mockCritic);

    assert.deepStrictEqual(receivedNames.sort(), [
      'completeness-structure',
      'facts-sources',
      'honesty-courage',
    ]);
  });

  it('returns median score from 3 critics', async () => {
    const scores = [6, 8, 7];
    let idx = 0;

    const mockCritic: RunCriticFn = async () => {
      const score = scores[idx++];
      return `===SCORE===\n${score}\n===ASSESSMENT===\nOK.\n===END===`;
    };

    const result = await runMultiCritic('test output', 'test task', mockCritic);
    assert.equal(result.medianScore, 7); // median of [6,7,8]
    assert.equal(result.critics.length, 3);
  });

  it('handles failed critics gracefully', async () => {
    let call = 0;
    const mockCritic: RunCriticFn = async () => {
      call++;
      if (call === 2) throw new Error('API error');
      return '===SCORE===\n8\n===ASSESSMENT===\nOK.\n===END===';
    };

    const result = await runMultiCritic('test output', 'test task', mockCritic);
    assert.equal(result.medianScore, 8); // median of [8, 8], one failed
    assert.equal(result.critics.filter(c => c.score > 0).length, 2);
  });

  it('returns 0 when all critics fail', async () => {
    const mockCritic: RunCriticFn = async () => {
      throw new Error('All fail');
    };

    const result = await runMultiCritic('test output', 'test task', mockCritic);
    assert.equal(result.medianScore, 0);
  });
});

// ─── v0.4.6 — Critic-set registry & anti-fallback regression ────

describe('getCriticPrompts — agent-specific sets (v0.4.6)', () => {
  it('returns 3 critics for every registered agent', () => {
    for (const agent of [
      'investigator', 'writer', 'marketing', 'blog-writer',
      'research', 'researcher', 'critic', 'analyst',
    ]) {
      const prompts = getCriticPrompts(agent);
      assert.equal(prompts.length, 3, `agent ${agent} must have 3 critic prompts`);
      const names = new Set(prompts.map((p) => p.name));
      assert.equal(names.size, 3, `agent ${agent} critic names must be unique`);
      for (const p of prompts) {
        assert.ok(p.prompt.length > 100, `agent ${agent} critic ${p.name} prompt too short`);
        assert.ok(p.prompt.includes('===SCORE==='), `agent ${agent} critic ${p.name} missing OUTPUT_FORMAT`);
      }
    }
  });

  // Anti-fallback regression: in v0.4.5 and earlier, analyst/researcher/critic
  // fell back to INVESTIGATOR_PROMPTS — which mis-scored their outputs (e.g.
  // code-analysis got dinged for "no URLs cited"). v0.4.6 fixes this with
  // dedicated sets. This test locks the fix.
  it('analyst uses code-analysis critics, NOT investigator (anti-fallback)', () => {
    const analyst = getCriticPrompts('analyst');
    const investigator = getCriticPrompts('investigator');
    const aNames = analyst.map((p) => p.name).sort();
    const iNames = investigator.map((p) => p.name).sort();
    assert.notDeepStrictEqual(aNames, iNames, 'analyst must NOT use investigator critic set');
    const blob = analyst.map((p) => p.prompt).join('\n').toLowerCase();
    assert.ok(blob.includes('file path') || blob.includes('file paths'),
      'analyst critics must reference file paths');
    assert.ok(blob.includes('function') || blob.includes('class'),
      'analyst critics must reference functions/classes');
  });

  it('research uses synthesis-quality critics, NOT investigator (anti-fallback)', () => {
    const research = getCriticPrompts('research');
    const investigator = getCriticPrompts('investigator');
    const rNames = research.map((p) => p.name).sort();
    const iNames = investigator.map((p) => p.name).sort();
    assert.notDeepStrictEqual(rNames, iNames, 'research must NOT use investigator critic set');
    const blob = research.map((p) => p.prompt).join('\n').toLowerCase();
    assert.ok(blob.includes('synthesis'), 'research critics must score synthesis');
    assert.ok(blob.includes('multi-engine') || blob.includes('cross-reference') || blob.includes('coverage'),
      'research critics must score source coverage');
  });

  it('critic uses critique-of-critique critics, NOT investigator (anti-fallback)', () => {
    const critic = getCriticPrompts('critic');
    const investigator = getCriticPrompts('investigator');
    const cNames = critic.map((p) => p.name).sort();
    const iNames = investigator.map((p) => p.name).sort();
    assert.notDeepStrictEqual(cNames, iNames, 'critic must NOT use investigator critic set');
    const blob = critic.map((p) => p.prompt).join('\n').toLowerCase();
    assert.ok(blob.includes('steelman'), 'critic critics must score steelmanning');
    assert.ok(blob.includes('verdict'), 'critic critics must score actionable verdict');
  });

  it('researcher is an alias of research (back-compat)', () => {
    const a = getCriticPrompts('research').map((p) => p.name).sort();
    const b = getCriticPrompts('researcher').map((p) => p.name).sort();
    assert.deepStrictEqual(a, b);
  });

  it('falls back to investigator for unknown agents', () => {
    const unknown = getCriticPrompts('totally-made-up-agent');
    const investigator = getCriticPrompts('investigator');
    assert.deepStrictEqual(
      unknown.map((p) => p.name).sort(),
      investigator.map((p) => p.name).sort(),
    );
  });
});

describe('runMultiCritic — uses agent-specific critic set (v0.4.6)', () => {
  it('passes analyst critic names when agentName=analyst', async () => {
    const received: string[] = [];
    const mock: RunCriticFn = async (_p, _t, name) => {
      received.push(name);
      return '===SCORE===\n8\n===ASSESSMENT===\nOK.\n===END===';
    };
    await runMultiCritic('analysis output', 'analyze codebase', mock, 'analyst');
    assert.deepStrictEqual(received.sort(), [
      'pattern-recognition', 'recommendation-quality', 'technical-accuracy',
    ]);
  });

  it('passes research critic names when agentName=research', async () => {
    const received: string[] = [];
    const mock: RunCriticFn = async (_p, _t, name) => {
      received.push(name);
      return '===SCORE===\n7\n===ASSESSMENT===\nOK.\n===END===';
    };
    await runMultiCritic('research report', 'survey topic X', mock, 'research');
    assert.deepStrictEqual(received.sort(), [
      'analytical-depth', 'completeness-decision', 'source-quality',
    ]);
  });

  it('passes critic critic names when agentName=critic', async () => {
    const received: string[] = [];
    const mock: RunCriticFn = async (_p, _t, name) => {
      received.push(name);
      return '===SCORE===\n6\n===ASSESSMENT===\nOK.\n===END===';
    };
    await runMultiCritic('critique', 'critique idea X', mock, 'critic');
    assert.deepStrictEqual(received.sort(), [
      'actionability-verdict', 'counter-argument-depth', 'fairness-steelman',
    ]);
  });
});

// ─── v0.7.0 — style-bias normalisation ──────────────────────────────

describe('stripMarkdownForJudging (v0.7.0)', () => {
  it('strips headers, bold, italic but keeps the words', () => {
    const md = '# Title\n\nThis is **bold** and *italic* and `code`.';
    const out = stripMarkdownForJudging(md);
    assert.ok(!out.includes('#'));
    assert.ok(!out.includes('**'));
    assert.ok(!out.includes('`'));
    assert.ok(out.includes('Title'));
    assert.ok(out.includes('bold'));
    assert.ok(out.includes('italic'));
    assert.ok(out.includes('code'));
  });

  it('strips list bullets and numbers but keeps items', () => {
    const md = '- first\n- second\n1. third';
    const out = stripMarkdownForJudging(md);
    assert.ok(/first/.test(out) && /second/.test(out) && /third/.test(out));
    assert.ok(!/^- /m.test(out));
    assert.ok(!/^\d+\. /m.test(out));
  });

  it('converts links to their text and images to alt', () => {
    const md = 'See [the docs](https://example.com) and ![logo](x.png).';
    const out = stripMarkdownForJudging(md);
    assert.ok(out.includes('the docs'));
    assert.ok(!out.includes('https://example.com'));
    assert.ok(out.includes('logo'));
  });

  it('flattens tables and drops separator rows + fences', () => {
    const md = '| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```js\nconst x=1;\n```';
    const out = stripMarkdownForJudging(md);
    assert.ok(!out.includes('|'));
    assert.ok(!out.includes('```'));
    assert.ok(out.includes('const x=1;'));
  });

  it('produces identical output for same content in different formats', () => {
    const markdown = '**Key point:** the *result* is `42`.';
    const plain = 'Key point: the result is 42.';
    // After stripping, the markdown reduces to the same words as the plain form
    const a = stripMarkdownForJudging(markdown);
    assert.equal(a, 'Key point: the result is 42.');
    assert.equal(stripMarkdownForJudging(plain), plain);
  });

  it('handles empty / non-string input', () => {
    assert.equal(stripMarkdownForJudging(''), '');
    assert.equal(stripMarkdownForJudging(undefined as unknown as string), '');
  });
});

describe('runMultiCritic — normalizeForJudging (v0.7.0)', () => {
  it('passes stripped output to critics when normalizeForJudging is on', async () => {
    let receivedTask = '';
    const mockCritic: RunCriticFn = async (_p, task) => {
      receivedTask = task;
      return '===SCORE===\n7\n===ASSESSMENT===\nok\n===END===';
    };
    await runMultiCritic('# Heading\n\n**bold** text', 'task', mockCritic, 'writer', {
      normalizeForJudging: true,
    });
    assert.ok(!receivedTask.includes('#'));
    assert.ok(!receivedTask.includes('**'));
    assert.ok(receivedTask.includes('Heading'));
    assert.ok(receivedTask.includes('bold'));
  });

  it('leaves output untouched when normalizeForJudging is off (default)', async () => {
    let receivedTask = '';
    const mockCritic: RunCriticFn = async (_p, task) => {
      receivedTask = task;
      return '===SCORE===\n7\n===ASSESSMENT===\nok\n===END===';
    };
    await runMultiCritic('# Heading\n\n**bold** text', 'task', mockCritic, 'writer');
    assert.ok(receivedTask.includes('# Heading'));
    assert.ok(receivedTask.includes('**bold**'));
  });
});

describe('stripMarkdownForJudging — hardening (v0.7.0 R1 fixes)', () => {
  it('preserves prose with a single mid-line pipe (not a table)', () => {
    const out = stripMarkdownForJudging('Choose option A | option B here.');
    assert.ok(out.includes('|'), 'single mid-line pipe must survive');
    assert.ok(out.includes('option A') && out.includes('option B'));
  });

  it('still flattens real table rows (edge pipes / >=2 pipes)', () => {
    const out = stripMarkdownForJudging('| A | B |\n| --- | --- |\n| 1 | 2 |');
    assert.ok(!out.includes('|'));
    assert.ok(out.includes('A') && out.includes('B') && out.includes('1') && out.includes('2'));
  });

  it('strips bold+italic triple-asterisk', () => {
    const out = stripMarkdownForJudging('This is ***very important*** text.');
    assert.ok(!out.includes('*'));
    assert.ok(out.includes('very important'));
  });
});

describe('runMultiCritic — custom critic sets + output label (v0.12.0)', () => {
  const OK = (score: number) => `===SCORE===\n${score}\n===ASSESSMENT===\nok\n===END===`;

  it('uses caller-supplied criticPrompts instead of the built-in lookup', async () => {
    const receivedNames: string[] = [];
    const receivedPrompts: string[] = [];
    const mockCritic: RunCriticFn = async (prompt, _task, criticName) => {
      receivedNames.push(criticName);
      receivedPrompts.push(prompt);
      return OK(8);
    };

    const result = await runMultiCritic('domain output', 'task', mockCritic, 'polis-haendler', {
      criticPrompts: [
        { name: 'action-quality', prompt: 'Judge action quality.' },
        { name: 'social-awareness', prompt: 'Judge social awareness.' },
        { name: 'game-fitness', prompt: 'Judge game fitness.' },
      ],
    });

    assert.deepStrictEqual(receivedNames.sort(), [
      'action-quality',
      'game-fitness',
      'social-awareness',
    ]);
    assert.ok(receivedPrompts.includes('Judge action quality.'));
    assert.strictEqual(result.medianScore, 8);
  });

  it('supports critic counts other than 3 (median over even count)', async () => {
    const scores = [6, 8];
    let idx = 0;
    const mockCritic: RunCriticFn = async () => OK(scores[idx++]);

    const result = await runMultiCritic('out', 'task', mockCritic, undefined, {
      criticPrompts: [
        { name: 'a', prompt: 'A' },
        { name: 'b', prompt: 'B' },
      ],
    });

    assert.strictEqual(result.medianScore, 7);
    assert.strictEqual(result.critics.length, 2);
  });

  it('drops invalid entries (holes, missing fields) instead of crashing — R1 Finding 3', async () => {
    const receivedNames: string[] = [];
    const mockCritic: RunCriticFn = async (_p, _t, criticName) => {
      receivedNames.push(criticName);
      return OK(8);
    };

    const holey = [
      undefined,
      { name: 'valid-judge', prompt: 'Judge it.' },
      { name: '', prompt: 'nameless' },
      { name: 'promptless' },
      null,
    ] as unknown as CriticPromptDef[];

    const result = await runMultiCritic('out', 'task', mockCritic, undefined, {
      criticPrompts: holey,
    });

    assert.deepStrictEqual(receivedNames, ['valid-judge']);
    assert.strictEqual(result.medianScore, 8);
  });

  it('falls back to the built-in lookup when NO entry is usable (all holes)', async () => {
    const receivedNames: string[] = [];
    const mockCritic: RunCriticFn = async (_p, _t, criticName) => {
      receivedNames.push(criticName);
      return OK(7);
    };

    await runMultiCritic('out', 'task', mockCritic, 'writer', {
      criticPrompts: [undefined, null] as unknown as CriticPromptDef[],
    });

    assert.deepStrictEqual(receivedNames.sort(), getCriticPrompts('writer').map((p) => p.name).sort());
  });

  it('falls back to the built-in lookup on a non-array criticPrompts value', async () => {
    const receivedNames: string[] = [];
    const mockCritic: RunCriticFn = async (_p, _t, criticName) => {
      receivedNames.push(criticName);
      return OK(7);
    };

    await runMultiCritic('out', 'task', mockCritic, 'writer', {
      criticPrompts: 'not-an-array' as unknown as CriticPromptDef[],
    });

    assert.strictEqual(receivedNames.length, 3);
  });

  it('falls back to the built-in lookup on an EMPTY criticPrompts array', async () => {
    const receivedNames: string[] = [];
    const mockCritic: RunCriticFn = async (_p, _t, criticName) => {
      receivedNames.push(criticName);
      return OK(7);
    };

    await runMultiCritic('out', 'task', mockCritic, 'writer', { criticPrompts: [] });

    // writer's built-in set, not zero critics
    assert.strictEqual(receivedNames.length, 3);
    assert.deepStrictEqual(receivedNames.sort(), getCriticPrompts('writer').map((p) => p.name).sort());
  });

  it('default path is unchanged when criticPrompts is not passed (v0.11 behaviour)', async () => {
    const receivedNames: string[] = [];
    const mockCritic: RunCriticFn = async (_p, _t, criticName) => {
      receivedNames.push(criticName);
      return OK(7);
    };

    await runMultiCritic('out', 'task', mockCritic, 'unknown-domain-agent');

    // unknown names still fall back to the investigator set
    assert.deepStrictEqual(receivedNames.sort(), getCriticPrompts('investigator').map((p) => p.name).sort());
  });

  it('outputLabel override lands in the evaluation preamble', async () => {
    let receivedTask = '';
    const mockCritic: RunCriticFn = async (_p, task) => {
      receivedTask = task;
      return OK(7);
    };

    await runMultiCritic('out', 'task', mockCritic, 'polis-haendler', {
      criticPrompts: [{ name: 'a', prompt: 'A' }],
      outputLabel: 'simulation turn',
    });

    assert.ok(receivedTask.startsWith('Evaluate the following simulation turn for the task'));
  });

  it('whitespace-only outputLabel is ignored (falls back to built-in/default label)', async () => {
    let receivedTask = '';
    const mockCritic: RunCriticFn = async (_p, task) => {
      receivedTask = task;
      return OK(7);
    };

    await runMultiCritic('out', 'task', mockCritic, 'writer', { outputLabel: '   ' });

    assert.ok(receivedTask.startsWith('Evaluate the following written content for the task'));
  });

  it('composes with normalizeForJudging (custom judges see stripped output)', async () => {
    let receivedTask = '';
    const mockCritic: RunCriticFn = async (_p, task) => {
      receivedTask = task;
      return OK(7);
    };

    await runMultiCritic('# H\n\n**bold**', 'task', mockCritic, undefined, {
      criticPrompts: [{ name: 'a', prompt: 'A' }],
      normalizeForJudging: true,
    });

    assert.ok(!receivedTask.includes('**'));
    assert.ok(receivedTask.includes('bold'));
  });
});
