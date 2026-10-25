import React from 'react';

const base = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' };
const I = (paths) => function Icon({ size = 16, ...p }) {
  return <svg {...base} width={size} height={size} aria-hidden="true" {...p}>{paths}</svg>;
};

export const ArchiveIcon = I(<><rect x="2" y="3" width="12" height="3" rx="1" /><path d="M3 6v6.5A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6" /><path d="M6.5 9h3" /></>);
export const InboxIcon = I(<><path d="M2 9.5 3.6 3.9A1.3 1.3 0 0 1 4.8 3h6.4a1.3 1.3 0 0 1 1.2.9L14 9.5" /><path d="M2 9.5V12a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 14 12V9.5h-3.3l-.9 1.6H6.2l-.9-1.6Z" /></>);
export const UnreadIcon = I(<><circle cx="8" cy="8" r="2.6" fill="currentColor" stroke="none" /><circle cx="8" cy="8" r="5.6" /></>);
export const ExternalIcon = I(<><path d="M9.5 2.5h4v4" /><path d="M13.5 2.5 7.5 8.5" /><path d="M12 9.5v3A1.5 1.5 0 0 1 10.5 14h-7A1.5 1.5 0 0 1 2 12.5v-7A1.5 1.5 0 0 1 3.5 4h3" /></>);
export const MuteIcon = I(<><path d="M6.5 13.5a1.6 1.6 0 0 0 3 0" /><path d="M4 7a4 4 0 0 1 6.9-2.8M12 7c0 3 1.5 4 1.5 4h-9" /><path d="m2 2 12 12" /></>);
export const BellIcon = I(<><path d="M6.5 13.5a1.6 1.6 0 0 0 3 0" /><path d="M4 7a4 4 0 0 1 8 0c0 3 1.5 4 1.5 4h-11S4 10 4 7Z" /></>);
export const HashIcon = I(<><path d="M3 6h10.5M2.5 10H13M6.5 2.5 5.5 13.5M10.5 2.5l-1 11" /></>);
export const LockIcon = I(<><rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></>);
export const SearchIcon = I(<><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></>);
export const SendIcon = I(<><path d="M8 13V3.5M3.5 7.5 8 3l4.5 4.5" /></>);
export const ThreadIcon = I(<><path d="M2.5 4.5A1.5 1.5 0 0 1 4 3h8a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 12 11H7l-3 2.5V11a1.5 1.5 0 0 1-1.5-1.5Z" /></>);
export const SmileIcon = I(<><circle cx="8" cy="8" r="5.8" /><path d="M5.8 9.6a2.8 2.8 0 0 0 4.4 0" /><path d="M6 6.4h.01M10 6.4h.01" strokeWidth="2" /></>);
export const CheckIcon = I(<path d="m3.5 8.5 3 3 6-7" />);
export const SettingsIcon = I(<><circle cx="8" cy="8" r="2" /><path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7 3.6 3.6" /></>);
export const FileIcon = I(<><path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6Z" /><path d="M9 2v4h4" /></>);
export const ChevronIcon = I(<path d="m6 4 4 4-4 4" />);
export const CloseIcon = I(<path d="M4 4l8 8M12 4l-8 8" />);
