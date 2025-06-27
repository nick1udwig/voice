# CLAUDE.md - Guide for working in this repository

## Build Commands
- `kit b --hyperapp` or `kit build --hyperapp` - Build the Hyperware package
- `kit bs` or `kit build-start-package` - Build and start a Hyperware package
- `kit d` or `kit dev-ui` - Start web UI development server with hot reloading
- `kit f` or `kit boot-fake-node` - Boot a fake node for development


## Code Style Guidelines
- **Formatting**: Rust 2021 edition conventions
- **Imports**: Group by source (stdlib, crate-specific, external)
- **Error handling**: Use `anyhow::Result<T>` for tests, `thiserror` for custom errors
- **Naming**: snake_case for functions/modules, test names follow `test_*` pattern
- **Types**: Use `serde` for serialization with common derives: `[PartialEq, serde::Deserialize, serde::Serialize, process_macros::SerdeJsonInto]`
- **Architecture**: Distributed with components (indexer, client, curator) using WIT interfaces


# Hyperware Process Framework Guide

## Overview
The Hyperware Process Framework is a Rust-based system for developing WebAssembly processes with async support, RPC-style communication, and automated state persistence. This document provides key information for working with this codebase.


## Project Structure
- `hyperprocess_macro/`: Main procedural macro implementation
  - Provides the `#[hyperprocess]` attribute macro
  - Handles code generation for request/response handling
- `hyperware_app_common/`: Common utilities and runtime support
  - Provides async runtime implementation
  - Contains helper functions for state management

## Code Style Guidelines
- **Naming Conventions:**
  - Types/Structs/Enums: `PascalCase` (e.g., `AppContext`, `ResponseFuture`)
  - Functions/Methods: `snake_case` (e.g., `initialize_state`, `handle_send_error`)
  - Constants: `SCREAMING_SNAKE_CASE` (e.g., `APP_CONTEXT`, `RESPONSE_REGISTRY`)
  - Macros: `snake_case` (e.g., `hyper!`)
  
- **Error Handling:**
  - Use `anyhow` for general error handling
  - Use `Result` pattern with detailed context
  - Use `SendResult` enum for RPC call results with variants: `Success`, `Timeout`, `Offline`, `DeserializationError`

- **Documentation:**
  - Add doc comments for all public items
  - Explain function parameters and return values
  - Describe state requirements and side effects

## Available Macros and Their Usage

### Attribute Macros

#### The `#[hyperprocess]` Macro

The primary macro that transforms a struct implementation into a WASM component. 

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | String | Yes | Human-readable name of your process |
| `icon` | String | No | Icon to display in UI (path or name) |
| `widget` | String | No | Widget type to display in UI |
| `ui` | Option\<HttpBindingConfig\> | Yes | UI configuration |
| `endpoints` | Vec\<Binding\> | Yes | HTTP and WebSocket endpoints |
| `save_config` | SaveOptions | Yes | When to persist state |
| `wit_world` | String | Yes | WIT world name for component model |

**Example:**

```rust
#[hyperprocess(
    name = "Task Manager",
    icon = "task-icon",
    widget = "task-widget",
    ui = Some(HttpBindingConfig::default()),
    endpoints = vec![
        Binding::Http { 
            path: "/api", 
            config: HttpBindingConfig::new(false, false, false, None) 
        }
    ],
    save_config = SaveOptions::EveryMessage,
    wit_world = "my-process-dot-os-v0"
)]
impl MyState {
    // Implementation goes here
}
```

**What It Does:**
- Analyzes the implementation block for handler methods
- Generates Request/Response enums based on method signatures
- Creates handler dispatch logic for different message types
- Sets up message loop, async runtime, and persistence
- Implements the WebAssembly component interface

#### Handler Attribute Macros

These macros mark methods for specific message handling:

##### `#[init]`

Marks a method to be called during process initialization.

**Requirements:**
- Must be `async`
- Must take only `&mut self` parameter
- Must not return a value
- Cannot be combined with other handler attributes

**Example:**
```rust
#[init]
async fn initialize(&mut self) {
    // Initialization code here
    self.data = load_initial_data().await;
}
```

##### `#[http]`

Marks a method to handle HTTP requests.

**Requirements:**
- Can be `async` or synchronous
- Must take `&mut self` as first parameter
- All other parameters must be deserializable
- Return value must be serializable

**Example:**
```rust
#[http]
async fn handle_post(&mut self, payload: CreateItemRequest) -> ApiResponse {
    // Handle HTTP request
    let item = self.create_item(payload).await?;
    ApiResponse::success(item)
}
```

##### `#[local]`

Marks a method to handle requests from processes on the same node.

**Requirements:**
- Can be `async` or synchronous
- Must take `&mut self` as first parameter
- All other parameters must be deserializable
- Return value must be serializable

**Example:**
```rust
#[local]
fn get_status(&mut self) -> StatusReport {
    StatusReport {
        uptime: self.uptime,
        requests_handled: self.count,
    }
}
```

##### `#[remote]`

Marks a method to handle requests from processes on different nodes.

**Requirements:**
- Can be `async` or synchronous
- Must take `&mut self` as first parameter
- All other parameters must be deserializable
- Return value must be serializable

**Example:**
```rust
#[remote]
async fn fetch_data(&mut self, query: DataQuery) -> Vec<DataItem> {
    // Process remote request
    self.database.query(query).await
}
```

##### `#[ws]`

Marks a method to handle WebSocket connections.

**Requirements:**
- Must be synchronous (not async)
- Must take exactly four parameters:
  1. `&mut self`
  2. `channel_id: u32`
  3. `message_type: WsMessageType`
  4. `blob: LazyLoadBlob`
- Must not return a value
- Cannot be combined with other handler attributes

**Example:**
```rust
#[ws]
fn handle_websocket(&mut self, channel_id: u32, message_type: WsMessageType, blob: LazyLoadBlob) {
    match message_type {
        WsMessageType::Binary => {
            // Handle binary message
            let message = serde_json::from_slice(blob.bytes()).unwrap();
            // Process message...
        }
        WsMessageType::Close => {
            // Handle connection close
            self.connections.remove(&channel_id);
        }
        _ => { /* Handle other message types */ }
    }
}
```

### Function-like Macros

#### The `hyper!` Macro

Spawns an async block on the framework's executor.

**Usage:**
```rust
hyper! {
    // Async code here
    let result = some_async_function().await;
    process_result(result);
}
```

**What It Does:**
- Takes a block of code containing async operations
- Wraps it in an async block
- Spawns it on the executor for later execution
- Enables async operations within synchronous contexts

### Helper Functions

#### `send<R>`

Sends a serializable message to another process and awaits the response.

**Signature:**
```rust
async fn send<R>(
    message: impl serde::Serialize,
    target: &Address,
    timeout_secs: u64,
) -> SendResult<R>
where
    R: serde::de::DeserializeOwned
```

**Parameters:**
- `message`: The serializable message to send
- `target`: Address of the target process
- `timeout_secs`: How long to wait for response (in seconds)

**Returns:**
- `SendResult::Success(R)`: Successfully received and deserialized response
- `SendResult::Timeout`: Request timed out
- `SendResult::Offline`: Target process is offline
- `SendResult::DeserializationError(String)`: Failed to deserialize response

**Example:**
```rust
let result: SendResult<DataResponse> = send(request, &target_address, 5).await;
match result {
    SendResult::Success(data) => {
        // Process successful response
    }
    SendResult::Timeout => {
        // Handle timeout
    }
    SendResult::Offline => {
        // Handle offline target
    }
    SendResult::DeserializationError(err) => {
        // Handle deserialization error
    }
}
```

#### `maybe_save_state<S>`

Persists the state according to the configured save options.

**Signature:**
```rust
fn maybe_save_state<S>(state: &S)
where
    S: serde::Serialize
```

**Parameters:**
- `state`: The serializable state to persist

**Example:**
```rust
// Will be called automatically by the framework
maybe_save_state(&self.state);
```

#### `get_path`

Gets the current HTTP path from the request context.

**Signature:**
```rust
fn get_path() -> Option<String>
```

**Returns:**
- The current HTTP path if handling an HTTP request, or None

**Example:**
```rust
if let Some(path) = get_path() {
    // Use path information
}
```

#### `get_server`

Gets a reference to the HTTP server.

**Signature:**
```rust
fn get_server() -> Option<&'static mut HttpServer>
```

**Returns:**
- A mutable reference to the HTTP server if available, or None

**Example:**
```rust
if let Some(server) = get_server() {
    // Use server for WebSocket communication or other server operations
    server.send_ws_message(channel_id, message_type, data);
}
```

## Key Types

### `SaveOptions`

Controls when state is persisted.

```rust
pub enum SaveOptions {
    // Never persist state
    Never,
    // Persist state after every message
    EveryMessage,
    // Persist state every N messages
    EveryNMessage(u64),
    // Persist state every N seconds
    EveryNSeconds(u64),
}
```

### `Binding`

Defines HTTP and WebSocket endpoints.

```rust
pub enum Binding {
    Http {
        path: &'static str,
        config: HttpBindingConfig,
    },
    Ws {
        path: &'static str,
        config: WsBindingConfig,
    },
}
```

### `SendResult<R>`

Result of an async RPC call.

```rust
pub enum SendResult<R> {
    Success(R),
    Timeout,
    Offline,
    DeserializationError(String),
}
```

## Framework Concepts

### Handler Types
- `#[http]`: Handle HTTP requests to process endpoints
- `#[local]`: Handle requests from processes on the same node
- `#[remote]`: Handle requests from processes on different nodes
- `#[init]`: Run once on process startup
- `#[ws]`: Handle WebSocket connections

### State Management
- State persists across request handling
- Configure persistence with `SaveOptions`:
  - `SaveOptions::Never`: Never persist state
  - `SaveOptions::EveryMessage`: Persist after every message
  - `SaveOptions::EveryNMessage(n)`: Persist every n messages
  - `SaveOptions::EveryNSeconds(n)`: Persist every n seconds

### Async Support
- Custom async runtime with UUID-based correlation
- Use async/await syntax in handlers
- Spawn tasks with the `hyper!` macro
- Send async messages with `send()` function

### Key Architecture Patterns
1. **Procedural Macros**: Transforms struct implementations into WebAssembly components
2. **Custom Async Runtime**: Single-threaded async execution
3. **Message Passing**: Communication via serialized messages between processes
4. **Code Generation**: Automatic generation of request/response handling code
5. **Correlation IDs**: UUID-based correlation for request/response matching

## Comprehensive Example

This example demonstrates a task management application with multiple endpoint types, asynchronous communication between processes, and state persistence.

```rust
use hyperware_app_common::{Binding, SaveOptions, SendResult};
use hyperware_process_lib::http::server::{HttpBindingConfig, WsBindingConfig, WsMessageType};
use hyperware_process_lib::{Address, LazyLoadBlob};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

// Import caller utilities after running hyper-bindgen
use caller_utils::task_storage::{add_task_remote_rpc, get_tasks_by_status_remote_rpc};

// Define task-related types
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum TaskStatus {
    Pending,
    InProgress,
    Completed,
    Cancelled,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Task {
    id: String,
    title: String,
    description: String,
    status: TaskStatus,
    created_at: u64,
    assigned_to: Option<String>,
}

// Define application state
#[derive(Default, Debug, Serialize, Deserialize)]
struct TaskManagerState {
    // In-memory task storage
    tasks: HashMap<String, Task>,
    
    // Track active WebSocket connections for real-time updates
    active_ws_connections: HashMap<u32, String>, // channel_id -> client_id
    
    // Analytics
    request_count: u64,
    task_creation_count: u64,
}

// Implement the application logic
#[hyperprocess(
    name = "Task Manager",
    icon = "task-icon",
    widget = "task-widget",
    ui = Some(HttpBindingConfig::new(true, true, false, None)),
    endpoints = vec![
        // Main API endpoint
        Binding::Http {
            path: "/api/tasks",
            config: HttpBindingConfig::new(false, false, false, None)
        },
        // WebSocket for real-time updates
        Binding::Ws {
            path: "/ws/tasks",
            config: WsBindingConfig::new(false, false, false)
        }
    ],
    save_config = SaveOptions::EveryNMessage(5),
    wit_world = "task-manager-dot-os-v0"
)]
impl TaskManagerState {
    /// Initialize the process on startup
    #[init]
    async fn initialize(&mut self) {
        // Simulate loading some initial data
        let default_task = Task {
            id: Uuid::new_v4().to_string(),
            title: "Welcome Task".to_string(),
            description: "This is your first task!".to_string(),
            status: TaskStatus::Pending,
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
            assigned_to: None,
        };
        
        self.tasks.insert(default_task.id.clone(), default_task);
        
        // Perform any async initialization with other processes
        match get_stored_tasks().await {
            Ok(stored_tasks) => {
                for task in stored_tasks {
                    self.tasks.insert(task.id.clone(), task);
                }
                hyperware_process_lib::logging::info!("Loaded {} tasks from storage", stored_tasks.len());
            }
            Err(e) => {
                hyperware_process_lib::logging::warn!("Failed to load tasks from storage: {:?}", e);
            }
        }
    }
    
    /// Create a new task via HTTP endpoint
    #[http]
    async fn create_task(&mut self, new_task_req: NewTaskRequest) -> TaskResponse {
        self.request_count += 1;
        
        // Generate new task with UUID
        let task_id = Uuid::new_v4().to_string();
        let task = Task {
            id: task_id.clone(),
            title: new_task_req.title,
            description: new_task_req.description,
            status: TaskStatus::Pending,
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
            assigned_to: new_task_req.assigned_to,
        };
        
        // Store task locally
        self.tasks.insert(task_id.clone(), task.clone());
        self.task_creation_count += 1;
        
        // Asynchronously store in the persistent storage process
        let storage_result = store_task_in_storage(&task).await;
        
        // Notify connected WebSocket clients about the new task
        self.broadcast_task_update(&task);
        
        // Return response with task info and storage status
        TaskResponse {
            success: true,
            task: Some(task),
            storage_status: storage_result.is_ok(),
            message: "Task created successfully".to_string(),
        }
    }
    
    /// Get a list of all tasks via HTTP endpoint
    #[http]
    fn get_all_tasks(&mut self) -> Vec<Task> {
        self.request_count += 1;
        self.tasks.values().cloned().collect()
    }
    
    /// Get a specific task by ID via HTTP endpoint
    #[http]
    fn get_task(&mut self, task_id: String) -> TaskResponse {
        self.request_count += 1;
        
        match self.tasks.get(&task_id) {
            Some(task) => TaskResponse {
                success: true,
                task: Some(task.clone()),
                storage_status: true,
                message: "Task found".to_string(),
            },
            None => TaskResponse {
                success: false,
                task: None,
                storage_status: true,
                message: "Task not found".to_string(),
            },
        }
    }
    
    /// Update a task's status via HTTP endpoint
    #[http]
    async fn update_task_status(&mut self, update_req: TaskStatusUpdateRequest) -> TaskResponse {
        self.request_count += 1;
        
        if let Some(task) = self.tasks.get_mut(&update_req.task_id) {
            task.status = update_req.new_status;
            
            // Store updated task in storage
            let storage_result = store_task_in_storage(task).await;
            
            // Notify connected clients
            self.broadcast_task_update(task);
            
            TaskResponse {
                success: true,
                task: Some(task.clone()),
                storage_status: storage_result.is_ok(),
                message: "Task updated successfully".to_string(),
            }
        } else {
            TaskResponse {
                success: false,
                task: None,
                storage_status: false,
                message: "Task not found".to_string(),
            }
        }
    }
    
    /// Handle local request to get task statistics
    #[local]
    fn get_statistics(&mut self) -> TaskManagerStats {
        TaskManagerStats {
            total_tasks: self.tasks.len() as u64,
            pending_tasks: self.tasks.values().filter(|t| matches!(t.status, TaskStatus::Pending)).count() as u64,
            completed_tasks: self.tasks.values().filter(|t| matches!(t.status, TaskStatus::Completed)).count() as u64,
            creation_count: self.task_creation_count,
            request_count: self.request_count,
        }
    }
    
    /// Handle both local and remote requests to get tasks by status
    #[local]
    #[remote]
    fn get_tasks_by_status(&mut self, status: TaskStatus) -> Vec<Task> {
        self.tasks
            .values()
            .filter(|task| task.status == status)
            .cloned()
            .collect()
    }
    
    /// Handle WebSocket messages for real-time updates
    #[ws]
    fn handle_websocket(&mut self, channel_id: u32, message_type: WsMessageType, blob: LazyLoadBlob) {
        match message_type {
            WsMessageType::Binary => {
                // Handle binary message (example: could be task updates from clients)
                if let Ok(ws_message) = serde_json::from_slice::<WebSocketMessage>(blob.bytes()) {
                    match ws_message {
                        WebSocketMessage::Subscribe { client_id } => {
                            // Register client for updates
                            self.active_ws_connections.insert(channel_id, client_id);
                            
                            // Send current tasks as initial data
                            if let Some(server) = hyperware_app_common::get_server() {
                                let tasks = self.get_all_tasks();
                                if let Ok(tasks_json) = serde_json::to_vec(&tasks) {
                                    let _ = server.send_ws_message(channel_id, WsMessageType::Binary, tasks_json);
                                }
                            }
                        }
                        WebSocketMessage::Unsubscribe => {
                            // Remove client subscription
                            self.active_ws_connections.remove(&channel_id);
                        }
                    }
                }
            }
            WsMessageType::Close => {
                // Client disconnected, remove from active connections
                self.active_ws_connections.remove(&channel_id);
            }
            _ => { /* Ignore other message types */ }
        }
    }
    
    // Helper method to broadcast updates to all connected WebSocket clients
    fn broadcast_task_update(&self, task: &Task) {
        if let Some(server) = hyperware_app_common::get_server() {
            if let Ok(task_json) = serde_json::to_vec(&task) {
                for channel_id in self.active_ws_connections.keys() {
                    let _ = server.send_ws_message(*channel_id, WsMessageType::Binary, task_json.clone());
                }
            }
        }
    }
}

// Supporting types for the application
#[derive(Debug, Serialize, Deserialize)]
struct NewTaskRequest {
    title: String,
    description: String,
    assigned_to: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct TaskStatusUpdateRequest {
    task_id: String,
    new_status: TaskStatus,
}

#[derive(Debug, Serialize, Deserialize)]
struct TaskResponse {
    success: bool,
    task: Option<Task>,
    storage_status: bool,
    message: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct TaskManagerStats {
    total_tasks: u64,
    pending_tasks: u64,
    completed_tasks: u64,
    creation_count: u64,
    request_count: u64,
}

#[derive(Debug, Serialize, Deserialize)]
enum WebSocketMessage {
    Subscribe { client_id: String },
    Unsubscribe,
}

// Helper functions for communicating with other processes
async fn store_task_in_storage(task: &Task) -> SendResult<bool> {
    // Get the address of the storage process
    let storage_addr = Address::process("task-storage:app:sys");
    
    // Call the remote function to store the task
    add_task_remote_rpc(&storage_addr, task.clone(), 5).await
}

async fn get_stored_tasks() -> Result<Vec<Task>, String> {
    // Get the address of the storage process
    let storage_addr = Address::process("task-storage:app:sys");
    
    // Call the remote function to get tasks
    match get_tasks_by_status_remote_rpc(&storage_addr, TaskStatus::Pending, 5).await {
        SendResult::Success(tasks) => Ok(tasks),
        SendResult::Timeout => Err("Timeout connecting to storage".to_string()),
        SendResult::Offline => Err("Storage service is offline".to_string()),
        SendResult::DeserializationError(e) => Err(format!("Failed to deserialize tasks: {}", e)),
    }
}
```

### Key Features Demonstrated

1. **Complete Process Configuration**:
   - Custom name, icon, and widget for UI integration
   - Multiple HTTP endpoints and WebSocket endpoint
   - Configurable state persistence (every 5 messages)

2. **Multiple Handler Types**:
   - `#[init]` for process startup
   - `#[http]` for RESTful API endpoints
   - `#[local]` and `#[remote]` for inter-process communication
   - `#[ws]` for WebSocket real-time updates

3. **Async Communication**:
   - Async handlers with `.await` syntax
   - Inter-process communication using `send()`
   - Proper error handling with `SendResult`

4. **WebSocket Support**:
   - Client subscription tracking
   - Real-time updates broadcast
   - Binary message handling

5. **State Management**:
   - Complex state with multiple collections
   - Persistence with configurable settings
   - Access to shared resources like HTTP server

6. **Error Handling**:
   - Proper error propagation
   - Detailed status responses
   - Graceful failure handling