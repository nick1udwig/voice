# Voice Call Application Implementation Plan

## Overview
This document outlines the detailed implementation plan for a voice call application with listeners, built using the Kinode framework. The application will be developed starting from the id/ app template, following the pattern: backend → generated interface → frontend.

## Architecture Overview

### Process Information
- **Process Name**: `call:voice:sys`
- **Entry Points**:
  - `/call:voice:sys` - Splash screen (host/join)
  - `/call:voice:sys/<call-id>` - Call screen
- **Call ID Format**: Three random words joined by hyphens (e.g., `banana-hello-helicopter`)

### User Roles
1. **Listener**: Can only listen to the call
2. **Chatter**: Can listen and use text chat
3. **Speaker**: Can listen, chat, and speak
4. **Admin**: Full permissions plus ability to promote/demote others

### User Types
1. **Authenticated Node Users**: Connect via node-to-node handshake
2. **Anonymous Browser Users**: Assigned `pleb-<word>` identities

## Phase 1: Backend Development

### 1. Backend Architecture Design

#### Core Components
- **Call Manager**: Handles call creation, joining, and termination
- **Participant Manager**: Tracks users, roles, and permissions
- **WebSocket Hub**: Manages real-time connections
- **Chat System**: Routes messages based on permissions
- **WebRTC Signaling**: Facilitates peer-to-peer voice connections
- **Authentication Service**: Handles node-to-node handshakes

#### State Management
```rust
struct VoiceState {
    calls: HashMap<CallId, Call>,
    connections: HashMap<ConnectionId, ParticipantId>,
    word_dictionary: Vec<String>,
}

struct Call {
    id: CallId,
    participants: HashMap<ParticipantId, Participant>,
    chat_history: Vec<ChatMessage>,
    created_at: u64,
    default_role: Role,
}

struct Participant {
    id: ParticipantId,
    display_name: String,
    role: Role,
    connection_type: ConnectionType,
    is_muted: bool,
}
```

### 2. Type Definitions for Auto-Generated WIT Interface

The WIT interface will be automatically generated from the Rust types and function signatures defined in `lib.rs`. The hyperprocess macro will create the appropriate WIT definitions during the build process.

Key types to define in Rust that will generate the WIT interface:
- Request/Response types for HTTP endpoints
- WebSocket message enums
- Shared data structures (participants, calls, etc.)
- Role and permission enums

### 3. Backend Implementation

Create `voice/src/lib.rs`:
```rust
use hyperprocess::{http, on_exit, on_init, process, websocket, ProcessContext, WebSocketContext};
use kinode_process_lib::{await_message, call_init, println, Address, Response};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use rand::seq::SliceRandom;
use http::StatusCode;

// Type definitions that will generate the WIT interface
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Role {
    Listener,
    Chatter,
    Speaker,
    Admin,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ConnectionType {
    Node(String),
    Browser,
}

// HTTP endpoint request/response types
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateCallRequest {
    pub default_role: Role,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallInfo {
    pub id: String,
    pub created_at: u64,
    pub participant_count: u32,
    pub default_role: Role,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JoinCallRequest {
    pub call_id: String,
    pub node_auth: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JoinInfo {
    pub call_id: String,
    pub participant_id: String,
    pub role: Role,
    pub auth_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallState {
    pub call_info: CallInfo,
    pub participants: Vec<ParticipantInfo>,
    pub chat_history: Vec<ChatMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParticipantInfo {
    pub id: String,
    pub display_name: String,
    pub role: Role,
    pub is_muted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: String,
    pub sender_id: String,
    pub sender_name: String,
    pub content: String,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeaveCallRequest {
    pub call_id: String,
    pub participant_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateRoleRequest {
    pub call_id: String,
    pub requester_id: String,
    pub target_id: String,
    pub new_role: Role,
}

// WebSocket message types
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum WsClientMessage {
    Chat(String),
    Mute(bool),
    WebrtcSignal(SignalData),
    Heartbeat,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum WsServerMessage {
    Chat(ChatMessage),
    ParticipantJoined(ParticipantInfo),
    ParticipantLeft(String),
    RoleUpdated(String, Role),
    ParticipantMuted(String, bool),
    WebrtcSignal(String, SignalData),
    Error(String),
    CallEnded,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalData {
    pub target: String,
    pub signal_type: String,
    pub payload: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct VoiceState {
    calls: HashMap<String, Call>,
    connections: HashMap<String, String>, // connection_id -> participant_id
    word_dictionary: Vec<String>,
    used_pleb_names: HashMap<String, Vec<String>>, // call_id -> used names
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Call {
    id: String,
    participants: HashMap<String, Participant>,
    chat_history: Vec<ChatMessage>,
    created_at: u64,
    default_role: Role,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Participant {
    id: String,
    display_name: String,
    role: Role,
    connection_type: ConnectionType,
    is_muted: bool,
}

// Main process implementation
process!(VoiceState);

#[init]
fn init(our: Address, ctx: &mut ProcessContext<VoiceState>) -> anyhow::Result<()> {
    println!("voice: initializing");

    // Load dictionary for random word generation
    let dictionary = load_dictionary();

    ctx.state = VoiceState {
        calls: HashMap::new(),
        connections: HashMap::new(),
        word_dictionary: dictionary,
        used_pleb_names: HashMap::new(),
    };

    // Set up periodic cleanup timer
    ctx.set_timer(60000, Some("cleanup".to_string()))?;

    Ok(())
}

#[http(method = "POST", path = "/create-call")]
fn create_call(
    ctx: &mut ProcessContext<VoiceState>,
    request: CreateCallRequest,
) -> anyhow::Result<(StatusCode, CallInfo)> {
    let state = &mut ctx.state;

    // Generate unique call ID
    let call_id = generate_call_id(&state.word_dictionary);

    let call = Call {
        id: call_id.clone(),
        participants: HashMap::new(),
        chat_history: Vec::new(),
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs(),
        default_role: request.default_role,
    };

    state.calls.insert(call_id.clone(), call);
    state.used_pleb_names.insert(call_id.clone(), Vec::new());

    let call_info = CallInfo {
        id: call_id,
        created_at: call.created_at,
        participant_count: 0,
        default_role: call.default_role,
    };

    Ok((StatusCode::OK, call_info))
}

#[http(method = "POST", path = "/join-call")]
fn join_call(
    ctx: &mut ProcessContext<VoiceState>,
    request: JoinCallRequest,
) -> anyhow::Result<(StatusCode, JoinInfo)> {
    let state = &mut ctx.state;

    // Verify call exists
    let call = state.calls.get_mut(&request.call_id)
        .ok_or_else(|| anyhow::anyhow!("Call not found"))?;

    // Determine participant identity and connection type
    let (participant_id, display_name, connection_type) = if let Some(auth) = request.node_auth {
        // Authenticated node user
        // TODO: Verify auth token and extract node identity
        let node_id = verify_node_auth(auth)?;
        (node_id.clone(), node_id, ConnectionType::Node(node_id))
    } else {
        // Anonymous browser user
        let pleb_name = generate_pleb_name(
            &state.word_dictionary,
            state.used_pleb_names.get_mut(&request.call_id).unwrap()
        );
        (pleb_name.clone(), pleb_name.clone(), ConnectionType::Browser)
    };

    // Create participant
    let participant = Participant {
        id: participant_id.clone(),
        display_name: display_name.clone(),
        role: call.default_role.clone(),
        connection_type,
        is_muted: true, // Start muted by default
    };

    call.participants.insert(participant_id.clone(), participant.clone());

    // Notify other participants
    let participant_info = ParticipantInfo {
        id: participant.id.clone(),
        display_name: participant.display_name.clone(),
        role: participant.role.clone(),
        is_muted: participant.is_muted,
    };
    broadcast_to_call(
        ctx,
        &request.call_id,
        WsServerMessage::ParticipantJoined(participant_info),
    )?;

    let join_info = JoinInfo {
        call_id: request.call_id,
        participant_id,
        role: call.default_role.clone(),
        auth_token: None, // TODO: Generate for WebSocket auth
    };

    Ok((StatusCode::OK, join_info))
}

#[http(method = "GET", path = "/get-call-info/{call_id}")]
fn get_call_info(
    ctx: &mut ProcessContext<VoiceState>,
    call_id: String,
) -> anyhow::Result<(StatusCode, CallState)> {
    let state = &ctx.state;

    // Verify call exists
    let call = state.calls.get(&call_id)
        .ok_or_else(|| anyhow::anyhow!("Call not found"))?;

    // Build participant info list
    let participants: Vec<ParticipantInfo> = call.participants.values()
        .map(|p| ParticipantInfo {
            id: p.id.clone(),
            display_name: p.display_name.clone(),
            role: p.role.clone(),
            is_muted: p.is_muted,
        })
        .collect();

    let call_state = CallState {
        call_info: CallInfo {
            id: call.id.clone(),
            created_at: call.created_at,
            participant_count: call.participants.len() as u32,
            default_role: call.default_role.clone(),
        },
        participants,
        chat_history: call.chat_history.clone(),
    };

    Ok((StatusCode::OK, call_state))
}

#[http(method = "POST", path = "/leave-call")]
fn leave_call(
    ctx: &mut ProcessContext<VoiceState>,
    request: LeaveCallRequest,
) -> anyhow::Result<StatusCode> {
    let state = &mut ctx.state;

    // Verify call exists
    let call = state.calls.get_mut(&request.call_id)
        .ok_or_else(|| anyhow::anyhow!("Call not found"))?;

    // Remove participant
    if let Some(participant) = call.participants.remove(&request.participant_id) {
        // Notify other participants
        broadcast_to_call(
            ctx,
            &request.call_id,
            WsServerMessage::ParticipantLeft(participant.id.clone()),
        )?;

        // Clean up connection mapping
        state.connections.retain(|_, pid| pid != &request.participant_id);

        // Check if call should be ended (no participants left)
        if call.participants.is_empty() {
            state.calls.remove(&request.call_id);
            state.used_pleb_names.remove(&request.call_id);
        }
    }

    Ok(StatusCode::OK)
}

#[http(method = "POST", path = "/update-role")]
fn update_role(
    ctx: &mut ProcessContext<VoiceState>,
    request: UpdateRoleRequest,
) -> anyhow::Result<StatusCode> {
    let state = &mut ctx.state;

    // Verify call exists
    let call = state.calls.get_mut(&request.call_id)
        .ok_or_else(|| anyhow::anyhow!("Call not found"))?;

    // Verify requester is admin
    let requester = call.participants.get(&request.requester_id)
        .ok_or_else(|| anyhow::anyhow!("Requester not found"))?;
    
    if !matches!(requester.role, Role::Admin) {
        return Err(anyhow::anyhow!("Unauthorized: Only admins can update roles"));
    }

    // Update target participant's role
    let participant = call.participants.get_mut(&request.target_id)
        .ok_or_else(|| anyhow::anyhow!("Target participant not found"))?;
    
    participant.role = request.new_role.clone();

    // Notify all participants of role change
    broadcast_to_call(
        ctx,
        &request.call_id,
        WsServerMessage::RoleUpdated(request.target_id.clone(), request.new_role),
    )?;

    Ok(StatusCode::OK)
}

#[ws]
fn handle_websocket(
    ctx: &mut WebSocketContext<VoiceState>,
    msg: WsClientMessage,
) -> anyhow::Result<()> {
    let state = &mut ctx.state;

    // Get participant info from connection
    let participant_id = state.connections.get(&ctx.connection_id)
        .ok_or_else(|| anyhow::anyhow!("Unknown connection"))?
        .clone();

    // Find which call this participant is in
    let call_id = find_participant_call(state, &participant_id)?;
    let call = state.calls.get_mut(&call_id).unwrap();
    let participant = call.participants.get_mut(&participant_id).unwrap();

    match msg {
        WsClientMessage::Chat(content) => {
            // Check permission
            if !can_chat(&participant.role) {
                ctx.send_json(&WsServerMessage::Error("No chat permission".to_string()))?;
                return Ok(());
            }

            let chat_msg = ChatMessage {
                id: generate_id(),
                sender_id: participant_id.clone(),
                sender_name: participant.display_name.clone(),
                content,
                timestamp: current_timestamp()?,
            };

            call.chat_history.push(chat_msg.clone());
            broadcast_to_call(ctx, &call_id, WsServerMessage::Chat(chat_msg))?;
        }
        WsClientMessage::Mute(is_muted) => {
            participant.is_muted = is_muted;
            broadcast_to_call(
                ctx,
                &call_id,
                WsServerMessage::ParticipantMuted(participant_id, is_muted),
            )?;
        }
        WsClientMessage::WebrtcSignal(signal) => {
            // Route WebRTC signaling to target participant
            send_to_participant(ctx, &signal.target,
                WsServerMessage::WebrtcSignal(participant_id, signal))?;
        }
        WsClientMessage::Heartbeat => {
            // Keep connection alive
        }
    }

    Ok(())
}

// Helper functions
fn generate_call_id(dictionary: &[String]) -> String {
    let mut rng = rand::thread_rng();
    let words: Vec<String> = dictionary.choose_multiple(&mut rng, 3)
        .map(|s| s.clone())
        .collect();
    words.join("-")
}

fn generate_pleb_name(dictionary: &[String], used_names: &mut Vec<String>) -> String {
    let mut rng = rand::thread_rng();
    loop {
        let word = dictionary.choose(&mut rng).unwrap();
        let name = format!("pleb-{}", word);
        if !used_names.contains(&name) {
            used_names.push(name.clone());
            return name;
        }
    }
}

fn can_chat(role: &Role) -> bool {
    matches!(role, Role::Chatter | Role::Speaker | Role::Admin)
}

fn can_speak(role: &Role) -> bool {
    matches!(role, Role::Speaker | Role::Admin)
}

fn load_dictionary() -> Vec<String> {
    // TODO: Load from file or embed
    vec![
        "apple", "banana", "cherry", "dog", "elephant", "forest",
        "galaxy", "hello", "island", "jungle", "kitten", "lemon",
        "mountain", "nebula", "ocean", "planet", "quantum", "rainbow",
        "sunset", "thunder", "universe", "volcano", "waterfall", "xylophone",
        "yellow", "zebra", "acoustic", "bicycle", "chocolate", "diamond",
        "emerald", "fountain", "guitar", "helicopter", "illusion", "jasmine"
    ].into_iter().map(String::from).collect()
}

fn find_participant_call(state: &VoiceState, participant_id: &str) -> anyhow::Result<String> {
    for (call_id, call) in &state.calls {
        if call.participants.contains_key(participant_id) {
            return Ok(call_id.clone());
        }
    }
    Err(anyhow::anyhow!("Participant not found in any call"))
}

fn broadcast_to_call(
    ctx: &mut ProcessContext<VoiceState>,
    call_id: &str,
    message: WsServerMessage,
) -> anyhow::Result<()> {
    // TODO: Implement WebSocket broadcast to all participants in the call
    // This would iterate through all connections and send the message
    // to participants who are in the specified call
    Ok(())
}

fn send_to_participant(
    ctx: &mut WebSocketContext<VoiceState>,
    participant_id: &str,
    message: WsServerMessage,
) -> anyhow::Result<()> {
    // TODO: Implement WebSocket message sending to specific participant
    // This would find the connection for the participant and send the message
    Ok(())
}

fn verify_node_auth(auth: String) -> anyhow::Result<String> {
    // TODO: Implement node authentication verification
    // This would validate the auth token and return the node identity
    Ok("node-identity".to_string())
}

fn generate_id() -> String {
    // Generate a unique ID for messages, etc.
    use rand::Rng;
    let mut rng = rand::thread_rng();
    format!("{:x}", rng.gen::<u64>())
}

fn current_timestamp() -> anyhow::Result<u64> {
    Ok(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs())
}
```

## Phase 2: Configuration & Build

### 4. Package Configuration

Create `metadata.json`:
```json
{
  "name": "voice",
  "version": "0.1.0",
  "description": "Voice call application with listeners",
  "package_name": "voice",
  "publisher": "sys",
  "dependencies": []
}
```

Create `pkg/manifest.json`:
```json
[
  {
    "process_name": "voice",
    "process_wasm_path": "/voice.wasm",
    "on_exit": "Restart",
    "request_networking": true,
    "request_capabilities": [
      {
        "process": "vfs:distro:sys",
        "params": {
          "root": true
        }
      },
      {
        "process": "http_server:distro:sys",
        "params": {
          "routes": ["/call:voice:sys", "/call:voice:sys/*"]
        }
      }
    ],
    "grant_capabilities": [],
    "public": true
  }
]
```

### 5. Build Process
1. Run `kit build --hyperapp` to compile backend and generate TypeScript bindings
2. Verify `target/ui/caller-utils.ts` contains generated API client
3. Check that WIT interfaces are properly processed

## Phase 3: Frontend Development

### 6. Frontend Architecture

#### Technology Stack
- React 18+ with TypeScript
- Vite for build tooling
- Zustand for state management
- React Router for navigation
- WebRTC APIs for voice
- Native WebSocket API

#### State Management Structure
```typescript
// stores/voiceStore.ts
interface VoiceStore {
  // Connection state
  nodeId: string | null;
  wsConnection: WebSocket | null;
  connectionStatus: 'disconnected' | 'connecting' | 'connected';

  // Call state
  currentCall: CallInfo | null;
  participants: Map<string, ParticipantInfo>;
  chatMessages: ChatMessage[];
  myParticipantId: string | null;
  myRole: Role;

  // WebRTC state
  peerConnections: Map<string, RTCPeerConnection>;
  localStream: MediaStream | null;
  remoteStreams: Map<string, MediaStream>;
  isMuted: boolean;

  // Actions
  createCall: (defaultRole: Role) => Promise<void>;
  joinCall: (callId: string) => Promise<void>;
  sendChatMessage: (content: string) => void;
  toggleMute: () => void;
  promoteParticipant: (participantId: string, newRole: Role) => void;
}
```

### 7. Splash Screen Implementation

Create `ui/src/components/SplashScreen.tsx`:
```typescript
const SplashScreen: React.FC = () => {
  const [joinLink, setJoinLink] = useState('');
  const [defaultRole, setDefaultRole] = useState<Role>('chatter');
  const { createCall, joinCall } = useVoiceStore();

  return (
    <div className="splash-container">
      <h1>Voice Call System</h1>

      <div className="action-section">
        <h2>Host a Call</h2>
        <select value={defaultRole} onChange={(e) => setDefaultRole(e.target.value as Role)}>
          <option value="listener">Listener (default)</option>
          <option value="chatter">Chatter (default)</option>
          <option value="speaker">Speaker (default)</option>
        </select>
        <button onClick={() => createCall(defaultRole)}>
          Create New Call
        </button>
      </div>

      <div className="action-section">
        <h2>Join a Call</h2>
        <input
          type="text"
          placeholder="Enter call link or ID"
          value={joinLink}
          onChange={(e) => setJoinLink(e.target.value)}
        />
        <button onClick={() => handleJoin(joinLink)}>
          Join Call
        </button>
      </div>
    </div>
  );
};
```

### 8. Call Screen Implementation

#### Main Layout
```typescript
const CallScreen: React.FC = () => {
  const { participants, myRole } = useVoiceStore();

  return (
    <div className="call-screen">
      <div className="main-content">
        <ParticipantGrid participants={participants} />
        <VoiceControls />
      </div>
      <div className="sidebar">
        <ParticipantList />
        <ChatPanel />
      </div>
    </div>
  );
};
```

#### Key Components
- **ParticipantList**: Shows all participants with role badges and admin controls
- **ChatPanel**: Message display with role-based input
- **VoiceControls**: Mute/unmute button for speakers
- **AdminControls**: Promote/demote buttons (admin only)

## Phase 4: Advanced Features

### 9. WebRTC Voice Implementation

#### Connection Flow
1. New participant joins → Create RTCPeerConnection
2. For speakers: Add local audio stream
3. Exchange offers/answers via WebSocket signaling
4. Handle ICE candidates
5. Manage connection lifecycle

#### Audio Management
```typescript
class VoiceManager {
  async initializeLocalAudio(): Promise<MediaStream> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    return stream;
  }

  createPeerConnection(participantId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    // Set up event handlers
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal(participantId, {
          type: 'ice-candidate',
          candidate: event.candidate
        });
      }
    };

    return pc;
  }
}
```

### 10. WebSocket Real-time Features

#### Connection Management
- Automatic reconnection with exponential backoff
- Message queuing during disconnection
- State synchronization on reconnect
- Heartbeat for connection monitoring

### 11. Chat System

#### Features
- Message history persistence
- Participant name display
- Timestamps
- Auto-scroll to latest
- Message status indicators

#### Permission Enforcement
- Input disabled for listeners
- Server-side validation
- Clear role indicators

### 12. Role Management System

#### Permission Matrix
| Action | Listener | Chatter | Speaker | Admin |
|--------|----------|---------|---------|-------|
| Listen | ✓ | ✓ | ✓ | ✓ |
| Chat | ✗ | ✓ | ✓ | ✓ |
| Speak | ✗ | ✗ | ✓ | ✓ |
| Promote/Demote | ✗ | ✗ | ✗ | ✓ |

#### Implementation
- Frontend UI updates based on role
- Backend validation for all actions
- Real-time role change notifications

### 13. Node Authentication

#### Handshake Protocol
1. Browser requests to join with node URL
2. Backend initiates node-to-node communication
3. Nodes exchange authentication tokens
4. Backend associates browser connection with node identity
5. Participant joins with authenticated identity

#### Security Considerations
- Time-limited auth tokens
- Secure token transmission
- Connection validation
- Identity verification

## Phase 5: Testing & Deployment

### 14. Testing Strategy

#### Unit Tests
- Backend logic for permissions
- Call management functions
- Dictionary and name generation

#### Integration Tests
- WebSocket message flow
- HTTP endpoint responses
- Node authentication

#### End-to-End Tests
- Complete user flows
- Multi-participant scenarios
- Role transitions
- Voice connectivity

### Deployment Checklist
1. Security audit
2. Performance testing
3. Load testing for concurrent calls
4. Documentation
5. Error handling and logging
6. Monitoring setup

## Implementation Timeline

### Week 1: Backend Core
- Days 1-2: WIT interfaces and basic structure
- Days 3-4: HTTP endpoints and state management
- Day 5: WebSocket implementation

### Week 2: Frontend Foundation
- Days 1-2: Project setup and routing
- Days 3-4: Splash and call screens
- Day 5: State management integration

### Week 3: Voice & Chat
- Days 1-3: WebRTC implementation
- Days 4-5: Chat system

### Week 4: Polish & Deploy
- Days 1-2: Role management and permissions
- Days 3-4: Node authentication
- Day 5: Testing and deployment

## Best Practices

### Code Quality
- Type safety throughout the stack
- Comprehensive error handling
- Clean separation of concerns
- Consistent code style

### Security
- Input validation
- Permission checks
- Secure WebRTC connections
- Protected admin functions

### Performance
- Efficient WebSocket message routing
- Lazy loading for UI components
- Connection pooling
- Resource cleanup

### User Experience
- Clear role indicators
- Smooth transitions
- Helpful error messages
- Responsive design
