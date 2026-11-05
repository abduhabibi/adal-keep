import test from 'node:test'
import assert from 'node:assert/strict'
import { chatsNamed } from '../src/services/telegramBackup.js'
import { PASSING } from '../src/services/whatsapp.js'

const post = (id, title, text) => ({ channel_post: { chat: { id, title, type: 'channel' }, text } })

test('only the channel with this agency name is offered', () => {
  const ups = [post(1, 'Zad Backup', 'Zad Agency'), post(2, 'Nuzla Backup', 'Nuzla Agency'), post(3, 'Other', 'hello')]
  assert.deepEqual(chatsNamed(ups, 'Nuzla Agency').map(c => c.id), [2])
})

test('capitals and spaces do not matter, a similar name does', () => {
  assert.deepEqual(chatsNamed([post(1, 'A', '  nuzla   AGENCY ')], 'Nuzla Agency').map(c => c.id), [1])
  assert.deepEqual(chatsNamed([post(1, 'A', 'Nuzla Agency Two')], 'Nuzla Agency'), [])
})

test('no name finds nothing, and neither do channels with no text or private chats', () => {
  assert.deepEqual(chatsNamed([post(1, 'A', '')], ''), [])
  assert.deepEqual(chatsNamed([{ my_chat_member: { chat: { id: 1, type: 'channel' } } }], 'X'), [])
  assert.deepEqual(chatsNamed([{ message: { chat: { id: 1, type: 'private' }, text: 'X' } }], 'X'), [])
})

test('WhatsApp errors that pass by themselves are told from real failures', () => {
  assert.ok(PASSING.test("Failed to add page binding with name onAddMessageEvent: window['onAddMessageEvent'] already exists!"))
  assert.ok(PASSING.test('Runtime.callFunctionOn timed out. Increase the protocolTimeout setting'))
  assert.ok(!PASSING.test('Nobody scanned the QR within 10 minutes'))
})
