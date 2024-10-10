var worker = require('./lib/worker');
var log = require('./lib/log');

log.log('Starting up mongo-k8s-sidecar @ 0.8.0');

worker.init(function(err) {
  if (err) {
    log.error('Error trying to initialize mongo-k8s-sidecar', err);
    return;
  }

  worker.workloop();
});
