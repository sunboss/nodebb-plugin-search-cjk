'use strict';

/*
 * nodebb-plugin-search-cjk
 * Full CJK (Chinese/Japanese/Korean) search for NodeBB using jieba segmentation.
 * Maintained by Muse for sunboss.
 *
 * Design:
 * - Uses @node-rs/jieba (Rust-based, fast, low memory) for word segmentation
 * - Hooks post/topic save to index segmented content
 * - Overrides db.search to segment queries before searching
 * - Bypasses English metaphone for CJK tokens
 */

const plugin = {};

let jieba = null;
let db = null;
let posts = null;
let topics = null;

function isCJK(text) {
	return /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af]/.test(text);
}

function segment(text) {
	if (!text || typeof text !== 'string') {
		return [];
	}
	if (!isCJK(text)) {
		// No CJK, return as-is split by whitespace
		return text.split(/\s+/).filter(Boolean);
	}
	try {
		// Use jieba for CJK text
		const words = jieba.cut(text, false);
		return words.filter(w => w.trim().length > 0);
	} catch (e) {
		// Fallback to bigram if jieba fails
		const tokens = [];
		const chars = [...text];
		for (let i = 0; i < chars.length; i++) {
			if (/[\u4e00-\u9fff]/.test(chars[i])) {
				tokens.push(chars[i]);
			}
		}
		for (let i = 0; i < chars.length - 1; i++) {
			if (/[\u4e00-\u9fff]/.test(chars[i]) || /[\u4e00-\u9fff]/.test(chars[i + 1])) {
				tokens.push(chars[i] + chars[i + 1]);
			}
		}
		return [...new Set(tokens)];
	}
}

plugin.init = async function (params) {
	const nconf = nodebb.require('nconf');
	db = nodebb.require('./src/database');
	posts = nodebb.require('./src/posts');
	topics = nodebb.require('./src/topics');

	// Load jieba
	try {
		jieba = require('@node-rs/jieba');
		jieba.load();
	} catch (e) {
		console.error('[search-cjk] Failed to load jieba:', e.message);
	}

	// Only support Redis for now (user's setup)
	if (nconf.get('database') !== 'redis') {
		console.warn('[search-cjk] Only Redis is supported currently');
		return;
	}

	const searchImpl = require('./lib/redis-search');
	
	// Override db search methods
	const origSearchIndex = db.searchIndex;
	const origSearch = db.search;
	const origSearchRemove = db.searchRemove;

	db.searchIndex = async function (key, data, ids) {
		return searchImpl.searchIndex(key, data, ids, { segment });
	};
	db.search = async function (key, data, limit) {
		return searchImpl.search(key, data, limit, { segment });
	};
	db.searchRemove = async function (key, ids) {
		return searchImpl.searchRemove(key, ids);
	};

	console.log('[search-cjk] CJK search initialized with jieba');
};

plugin.onPostSave = async function (data) {
	if (!data || !data.post) return;
	const isDeleted = await topics.getTopicField(data.post.tid, 'deleted');
	if (!isDeleted) {
		// Re-index with CJK segmentation
		const postData = await posts.getPostData(data.post.pid);
		if (postData) {
			await db.searchIndex('post', [{
				content: postData.content,
				tid: postData.tid,
				uid: postData.uid,
			}], [postData.pid]);
		}
	}
};

plugin.onPostDelete = async function (data) {
	if (data && data.post && data.post.pid) {
		await db.searchRemove('post', [data.post.pid]);
	}
};

plugin.onPostsPurge = async function (data) {
	if (data && data.posts) {
		const pids = data.posts.map(p => p && p.pid).filter(Boolean);
		if (pids.length) {
			await db.searchRemove('post', pids);
		}
	}
};

plugin.onTopicSave = async function (data) {
	if (!data || !data.topic) return;
	await db.searchIndex('topic', [{
		title: data.topic.title,
		content: data.topic.title,
		cid: data.topic.cid,
	}], [data.topic.tid]);
};

plugin.onTopicDelete = async function (data) {
	if (data && data.topic && data.topic.tid) {
		await db.searchRemove('topic', [data.topic.tid]);
	}
};

module.exports = plugin;
