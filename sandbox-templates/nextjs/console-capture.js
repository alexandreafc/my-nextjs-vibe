(function() {
  if (typeof window === 'undefined' || !window.parent || window.parent === window) return;

  var methods = ['log', 'warn', 'error', 'info', 'debug'];
  var originals = {};

  function safeStringify(obj) {
    var seen = new WeakSet();
    return JSON.stringify(obj, function(key, value) {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      if (value instanceof Error) {
        return { message: value.message, stack: value.stack };
      }
      if (typeof value === 'function') return '[Function: ' + (value.name || 'anonymous') + ']';
      if (typeof value === 'undefined') return '[undefined]';
      return value;
    });
  }

  methods.forEach(function(method) {
    originals[method] = console[method];
    console[method] = function() {
      originals[method].apply(console, arguments);
      try {
        var args = Array.prototype.slice.call(arguments).map(function(arg) {
          if (typeof arg === 'string') return arg;
          try { return safeStringify(arg); }
          catch(e) { return String(arg); }
        });
        window.parent.postMessage({
          type: 'console-log',
          level: method,
          args: args,
          timestamp: new Date().toISOString()
        }, '*');
      } catch(e) {}
    };
  });

  window.onerror = function(message, source, lineno, colno, error) {
    try {
      window.parent.postMessage({
        type: 'console-log',
        level: 'error',
        args: ['Uncaught Error: ' + message + ' at ' + source + ':' + lineno + ':' + colno],
        timestamp: new Date().toISOString()
      }, '*');
    } catch(e) {}
  };

  window.addEventListener('unhandledrejection', function(event) {
    try {
      var reason = event.reason;
      var msg = reason instanceof Error ? reason.message : String(reason);
      window.parent.postMessage({
        type: 'console-log',
        level: 'error',
        args: ['Unhandled Promise Rejection: ' + msg],
        timestamp: new Date().toISOString()
      }, '*');
    } catch(e) {}
  });
})();
