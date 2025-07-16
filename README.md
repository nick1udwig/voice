# voice

Voice call with listeners

## Building

You will need to get the WASI SDK clang to build:

Linux instructions:

```
# Download the latest WASI SDK (adjust version as needed)
wget https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-24/wasi-sdk-24.0-x86_64-linux.tar.gz

# Extract it
tar xvf wasi-sdk-24.0-x86_64-linux.tar.gz

export WASI_SDK_PATH=$(realpath wasi-sdk-24.0-x86_64-linux)
export CC_wasm32_wasip1="${WASI_SDK_PATH}/bin/clang"
export AR_wasm32_wasip1="${WASI_SDK_PATH}/bin/llvm-ar"
export CFLAGS_wasm32_wasip1="--sysroot=${WASI_SDK_PATH}/share/wasi-sysroot"
```
