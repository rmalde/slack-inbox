import React, { useState } from 'react';
import { hueFor, initials } from '../lib/format';
import { HashIcon, LockIcon } from './Icons';

export default function Avatar({ user, dir, size = 36, botName, botIcon, channel }) {
  const [broken, setBroken] = useState(false);
  if (channel) {
    return (
      <div className="avatar channel" style={{ width: size, height: size, '--h': hueFor(channel.id) }}>
        {channel.private ? <LockIcon size={size * 0.42} /> : <HashIcon size={size * 0.46} />}
      </div>
    );
  }
  const u = user && dir.users[user];
  const src = botIcon || (u && u.avatar);
  const name = (u && u.name) || botName || '?';
  if (src && !broken) {
    return <img className="avatar" src={src} alt="" width={size} height={size} style={{ width: size, height: size }} onError={() => setBroken(true)} draggable={false} />;
  }
  return (
    <div className="avatar initials" style={{ width: size, height: size, fontSize: size * 0.38, '--h': hueFor(user || botName || '') }}>
      {initials(name)}
    </div>
  );
}
