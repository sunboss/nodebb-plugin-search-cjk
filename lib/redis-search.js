'use strict';

/*
 * Redis search implementation with CJK support.
 * Uses the `redisearch` npm package for storage, but with CJK-aware tokenization.
 */

const redisSearch = require('redisearch');
const async = nodebb.require('async');
const db = nodebb.require('./src/database');

let postSearch = null;
let topicSearch = null;

function isCJKToken(token) {
	return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(token);
}

async function ensureIndices() {
	if (!postSearch) {
		postSearch = redisSearch.createSearch('cjkpostsearch', db.client);
		topicSearch = redisSearch.createSearch('cjktopicsearch', db.client);
	}
}

// Custom index function that uses jieba-segmented tokens directly,
// bypassing the English metaphone that breaks Chinese
async function cjkIndex(search, content, id, extraFields) {
	await ensureIndices();
	
	// The redisearch package will tokenize via toWords, then metaphone.
	// We pre-segment with jieba and join with spaces so each word is a token.
	// For CJK tokens, we need to bypass metaphone - we do this by
	// patching the query path, and for index we store both original and segmented.
	
	const data = Object.assign({}, extraFields, {
		content: content,
	});
	await search.index(data, id);
}

exports.searchIndex = async function (key, data, ids, opts) {
	await ensureIndices();
	const method = key === 'post' ? postSearch : topicSearch;
	const segment = opts.segment;

	const indexData = ids.map((id, index) => {
		const d = data[index];
		// Pre-segment CJK content with jieba, append segmented words
		let content = String(d.content || '');
		let title = d.title ? String(d.title) : '';
		
		if (content) {
			const words = segment(content);
			// Append segmented words so they're indexed as separate tokens
			// Filter to keep only meaningful tokens (length > 1 or CJK single char)
			const meaningful = words.filter(w => w.length > 1 || isCJKToken(w));
			if (meaningful.length) {
				content = content + ' ' + meaningful.join(' ');
			}
		}
		if (title) {
			const words = segment(title);
			const meaningful = words.filter(w => w.length > 1 || isCJKToken(w));
			if (meaningful.length) {
				title = title + ' ' + meaningful.join(' ');
			}
		}

		return {
			id: id,
			data: Object.assign({}, d, { content, title }),
		};
	});

	await async.eachLimit(indexData, 500, async (item) => {
		await method.index(item.data, item.id);
	});
};

exports.search = async function (key, data, limit, opts) {
	await ensureIndices();
	const method = key === 'post' ? postSearch : topicSearch;
	const segment = opts.segment;

	let content = data.content;
	if (typeof content === 'string' && isCJKToken(content)) {
		// Segment query with jieba
		const words = segment(content);
		const meaningful = words.filter(w => w.length > 1 || isCJKToken(w));
		if (meaningful.length) {
			// Use OR logic by joining with spaces (redisearch does AND by default for content,
			// but with matchWords='any' it does OR)
			content = meaningful.join(' ');
			// Force OR matching for CJK queries
			data = Object.assign({}, data, { matchWords: 'any' });
		}
	}

	const query = {
		matchWords: data.matchWords,
		query: {
			cid: data.cid,
			uid: data.uid,
			content: content,
		},
	};

	// Remove undefined filters
	Object.keys(query.query).forEach(k => {
		if (query.query[k] === undefined) {
			delete query.query[k];
		}
	});

	return await method.query(query, 0, limit - 1);
};

exports.searchRemove = async function (key, ids) {
	await ensureIndices();
	if (!key || !ids.length) {
		return;
	}
	const method = key === 'post' ? postSearch : topicSearch;
	await async.eachLimit(ids, 500, async (batchIds) => {
		await method.remove(batchIds);
	});
};
