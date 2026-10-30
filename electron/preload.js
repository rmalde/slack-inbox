'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const inv = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('api', {
  list: inv('inbox:list'),
  directory: inv('directory:get'),
  messages: inv('item:messages'),
  threadMessages: inv('thread:messages'),
  threadSend: inv('thread:send'),
  channelMessages: inv('channel:messages'),
  channelSend: inv('channel:send'),
  open: inv('item:open'),
  markUnread: inv('item:unread'),
  archive: inv('item:archive'),
  unarchive: inv('item:unarchive'),
  send: inv('item:send'),
  react: inv('item:react'),
  openInSlack: inv('item:openInSlack'),
  fixWithAgent: inv('agent:fix'),
  toggleMute: inv('mute:toggleLocal'),
  signIn: inv('session:signIn'),
  signOut: inv('session:signOut'),
  getSettings: inv('settings:get'),
  setSettings: inv('settings:set'),
  syncNow: inv('sync:now'),
  openExternal: inv('open:external'),
  isDark: inv('theme:isDark'),
  on: (channel, cb) => {
    const allowed = ['inbox-changed', 'directory-changed', 'session-changed', 'theme-changed', 'cmd', 'select', 'focus'];
    if (!allowed.includes(channel)) return () => {};
    const h = (_e, ...args) => cb(...args);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
});
