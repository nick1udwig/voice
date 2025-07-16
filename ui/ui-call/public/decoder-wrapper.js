// Wrapper for the opus decoder that configures the WASM file location
self.Module = {
  locateFile: function(path) {
    if (path.endsWith('.wasm')) {
      // Return the correct path for the WASM file
      // Remove any 'assets/' prefix since we're serving from root
      return self.location.origin + self.location.pathname.replace(/\/[^/]*$/, '/') + path;
    }
    return path;
  }
};

// Import the actual decoder worker
importScripts('./decoderWorker.min.js');