// Gör om ett användar-id till ett riktigt ObjectId innan det sparas.
// user-link.idOf släpper bara igenom 24 tecken hex, aldrig ObjectId.id (12 råa byte).
const mongoose = require('mongoose');
const userLink = require('./public/js/user-link');

function storedUserId(value) {
  const hex = userLink.idOf(value);
  if (!hex) return null;
  return new mongoose.Types.ObjectId(hex);
}

function persistActor(actor) {
  const link = userLink.actorFields(actor);
  if (!link.userId) return {};
  const userId = storedUserId(link.userId);
  if (!userId) return {};
  return { userId, actorName: link.actorName || '' };
}

function withdrawalEntry(actor, body) {
  const input = body || {};
  const link = persistActor(actor);
  return {
    time: input.time || new Date().toLocaleString('sv-SE'),
    productName: input.productName,
    qty: input.qty || 1,
    userName: (actor && actor.name) || input.userName || '—',
    articleNo: input.articleNo || '—',
    supplier: input.supplier || '—',
    ...link
  };
}

module.exports = { storedUserId, persistActor, withdrawalEntry };
