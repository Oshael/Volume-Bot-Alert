'use strict';

// Write path for observed posts (Bloco 3). savePost is idempotent: re-seeing a
// post (the same one shows up on every poll) updates the mutable snapshot
// instead of duplicating. Post + media are written in one transaction so a
// post never lands without its media or vice versa.

const db = require('../models/db');

async function savePost({ post, media = [] }) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO x_post
         (post_id, author_rest_id, author_screen_name, author_followers,
          text, lang, posted_at, retweet_of_post_id, engagement, ingested_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW())
       ON CONFLICT (post_id) DO UPDATE SET
         author_followers = EXCLUDED.author_followers,
         text = EXCLUDED.text,
         engagement = EXCLUDED.engagement`,
      [
        post.postId,
        post.authorRestId || null,
        post.authorScreenName || null,
        post.authorFollowers ?? null,
        post.text ?? null,
        post.lang || null,
        post.postedAt || null,
        post.retweetOfPostId || null,
        JSON.stringify(post.engagement || {}),
      ],
    );
    for (const item of media) {
      await client.query(
        `INSERT INTO x_post_media (post_id, media_index, media_url, media_type)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (post_id, media_index) DO UPDATE SET
           media_url = EXCLUDED.media_url,
           media_type = EXCLUDED.media_type`,
        [post.postId, item.mediaIndex, item.mediaUrl, item.mediaType || null],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { savePost };
