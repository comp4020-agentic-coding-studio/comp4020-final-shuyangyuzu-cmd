// Shared, framework-free recipe semantics. Rendering always uses text nodes.
export const RECIPE_UNITS = ['ml', 'g', 'tsp', 'tbsp', 'piece', 'slice', 'drop', 'leaf', 'sprig', 'pinch', 'cup', 'bar spoon', 'to taste'];
export function ingredientKey(value) {
    const key = String(value).normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
    return ({ 'fresh lime juice': 'lime juice', 'fresh lemon juice': 'lemon juice', 'sugar syrup': 'simple syrup', 'soda': 'soda water', 'club soda': 'soda water', 'white sugar': 'sugar' })[key] || key;
}
export function searchText(value) { return String(value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
function closeWord(a, b) { if (a.length < 4 || Math.abs(a.length - b.length) > 1)
    return false; let i = 0, j = 0, errors = 0; while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
        i++;
        j++;
        continue;
    }
    if (++errors > 1)
        return false;
    if (a.length >= b.length)
        i++;
    if (b.length >= a.length)
        j++;
} return errors + (i < a.length || j < b.length ? 1 : 0) <= 1; }
export function searchScore(text, query) {
    const hay = searchText(text), need = searchText(query);
    if (!need)
        return 1;
    if (hay.includes(need))
        return 100 + (hay.startsWith(need) ? 20 : 0);
    const words = hay.split(' ');
    let score = 0;
    for (const token of need.split(' ').slice(0, 6)) {
        if (words.some(w => w.includes(token)))
            score += 15;
        else if (words.some(w => closeWord(token, w)))
            score += 5;
    }
    return score;
}
export function recipeMeasures(recipe, glasses) {
    if (!Number.isInteger(glasses) || glasses < 1 || glasses > 20)
        throw Error('Choose 1–20 glasses.');
    return recipe.ingredients.map(i => ({ ...i, amount: i.amount === null ? null : Math.round(i.amount * glasses / recipe.serves * 100) / 100 }));
}
export function recipeShopping(plans, pantry = []) {
    const have = new Set(pantry.map(ingredientKey)), totals = new Map();
    for (const plan of plans)
        for (const i of recipeMeasures(plan.snapshot, plan.glasses)) {
            const key = ingredientKey(i.name) + '|' + i.unit;
            const old = totals.get(key);
            totals.set(key, { ...i, key, onHand: have.has(ingredientKey(i.name)), amount: i.amount === null ? null : (old?.amount ?? 0) + i.amount });
        }
    return [...totals.values()].sort((a, b) => a.name.localeCompare(b.name));
}
