/**
 * Item search API config for local dev. Copy to itemSearchConfig.js and set your API key.
 * itemSearchConfig.js is gitignored so your key is not committed.
 * On Vercel: set ITEM_SEARCH_API_KEY in Project → Settings → Environment Variables; the app uses /api/item-search and keeps the key server-side.
 */
var ITEM_SEARCH_CONFIG = {
  baseUrl: 'https://dndquarm.com/api/QuarmData/items/search',
  apiKey: 'YOUR_API_KEY_HERE'
};
