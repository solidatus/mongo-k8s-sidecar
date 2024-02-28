var worker = require('./lib/worker');

console.log('Starting up mongo-k8s-sidecar @ 0.2.0');

worker.init(function(err) {
  if (err) {
    console.error('Error trying to initialize mongo-k8s-sidecar', err);
    return;
  }

  worker.workloop();
});
