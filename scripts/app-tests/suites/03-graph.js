// Archive documents in the graph, with filters and color groups (issue #2).
// Graph options are set through the graph's own controls and reset afterwards.

const leaf = ws.getLeaf('tab');
await leaf.setViewState({ type: 'graph', active: true });
await sleep(1500);
const engine = leaf.view.dataEngine;
const original = engine.getOptions();
const show = async (options) => {
  engine.setOptions({ ...engine.getOptions(), ...options });
  engine.updateSearch();
  await sleep(2500);
  const nodes = leaf.view.renderer.nodes.map((n) => ({ id: n.id, color: n.color ? n.color.rgb : null }));
  return {
    recipes: nodes.filter((n) => n.id.startsWith('Recipes.mdz')),
    otherArchives: nodes.filter((n) => n.id.includes('.mdz') && !n.id.startsWith('Recipes.mdz')),
    notes: nodes.filter((n) => !n.id.includes('.mdz')),
  };
};
const RED = { a: 1, rgb: 0xff0000 };

try {
  await check('Archive documents appear as nodes, without stand-ins for resolved links', async () => {
    const g = await show({ search: '', colorGroups: [] });
    const ids = g.recipes.map((n) => n.id);
    return { ok: ids.includes('Recipes.mdz/recipes/pancakes.md') && g.otherArchives.length > 200 && !g.notes.some((n) => n.id === 'Project.mdz/chapters/intro'), detail: ids };
  });

  await check('A color group matching an archive colors its documents (#2)', async () => {
    const g = await show({ search: '', colorGroups: [{ query: 'path:"Recipes.mdz"', color: RED }] });
    return { ok: g.recipes.length === 4 && g.recipes.every((n) => n.color === RED.rgb) && g.otherArchives.length > 200, detail: g.recipes };
  });

  await check('A color group for notes keeps archive documents, uncolored (#2)', async () => {
    const g = await show({ search: '', colorGroups: [{ query: 'path:People', color: RED }] });
    return { ok: g.recipes.length === 4 && g.recipes.every((n) => n.color === null) && g.notes.some((n) => n.color === RED.rgb), detail: g.recipes };
  });

  await check('A search filter matching an archive shows only its documents', async () => {
    const g = await show({ search: 'path:"Recipes.mdz"', colorGroups: [] });
    return { ok: g.recipes.length === 4 && !g.otherArchives.length && !g.notes.length, detail: g };
  });

  await check('A search filter for notes hides archive documents', async () => {
    const g = await show({ search: 'path:People', colorGroups: [] });
    return { ok: !g.recipes.length && !g.otherArchives.length && g.notes.length === 2, detail: g.notes };
  });
} finally {
  engine.setOptions(original);
  engine.updateSearch();
  await sleep(500);
  leaf.detach();
}
