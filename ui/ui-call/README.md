# Voice Call UI

This is a minimal React application that provides the in-call user interface for the voice application. It's designed to be served at `/call/*` and handles voice calls without requiring the full application routing.

## Architecture

- **Standalone React App**: This UI is separate from the main application and only contains the call-specific functionality
- **Backend Integration**: The backend injects the call ID via `window.VOICE_CALL_ID` when serving the HTML
- **WebSocket Connection**: Connects directly to the backend WebSocket for real-time updates
- **Authentication**: Supports both authenticated (with node auth token) and unauthenticated users

## Structure

```
pkg/ui-call/
├── src/
│   ├── components/
│   │   └── CallScreen.tsx    # Main call interface component
│   ├── store/
│   │   └── voice.ts          # Zustand store for call state
│   ├── types.ts              # TypeScript type definitions
│   ├── main.tsx              # React entry point
│   └── index.css             # Styles
├── index.html                # HTML entry point
├── package.json              # Dependencies
└── vite.config.ts            # Build configuration
```

## Features

- Display call participants with roles (Listener, Chatter, Speaker, Admin)
- Real-time chat functionality
- Voice controls (mute/unmute for Speakers and Admins)
- Responsive design for mobile and desktop
- Light/dark mode support

## Development

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Build for production
npm run build
```

## Integration

The backend should:
1. Serve the built files at `/call/*`
2. Inject the call ID into the HTML as `window.VOICE_CALL_ID`
3. Handle WebSocket connections at `/ws`
4. Provide API endpoints for joining calls