var util = require('util');
var fs = require('fs');
var net = require('net');
var path = require('path');
var events = require('events');
var os = require('os');
var async = require('async');
var Metrics = require('metrics-server').metric;
var hyperquest = require('hyperquest')
var concat = require('concat-stream')

var oneMegabyte = 1024 * 1024;
var oneGigabyte = 1024 * oneMegabyte;

function humanize(num, size, units) {
	var unit;
	for ( unit = units.pop(); units.length && num >= size; unit = units.pop()) {
		num /= size;
	}
	return [num, unit];
}

function humanizeMetric(num) {
	var ret = humanize(num, 1000, ["TB", "GB", "MB", "KB", "Bytes"]);
	return ret[0].toFixed(2) + " " + ret[1];
}

function getInterval(current, previous) {
	var cur = new Date(current);
	var prev = new Date(previous);

	// ms -> ns.
	return (cur.getTime() - prev.getTime()) * 1000000;
}

var Cadvisor = function(options) {
	events.EventEmitter.call(this);

	this.options = options;
	this.time = 0;
	this.id = options.id;
	this.metrics = {};
	this.machine = null;
	this.timmer = 0;
	this.interval = options.interval;
	this.host = options.protocol + options.host + ':' + options.port;
	this.tokens = [];
};
//
// Inherit from `events.EventEmitter`.
//
util.inherits(Cadvisor, events.EventEmitter);

Cadvisor.prototype.start = function() {
	var self = this;

	if (this.machine !== null) {
		this._timmer();
		this._loop();
	} else {
		this.once('_machine', function(machine) {
			self._timmer();
			this.once('_loop', function(machine) {
				self.emit('tokens', self.tokens);
			});
			self._loop();
		});
		this._machine();
	}
};

Cadvisor.prototype.stop = function() {

};

Cadvisor.prototype._timmer = function() {
	var self = this;
	if (this.timmer == 0) {
		this.timmer = setInterval(this._loop.bind(this), this.interval || 5000);
	}
};
Cadvisor.prototype._machine = function() {
	var self = this;
	this._request('/api/v1.0/machine', function(err, machineInfo) {
		self.machine = machineInfo;
		self.emit('_machine', machineInfo);
	});
};

Cadvisor.prototype._createMetris = function(key) {
	var m = this.metrics[key] = Metrics.createMetric(this.options.metrics);
	m.interval = false;
	this.tokens.push(this.id + '.' + key);

	m.token = this.id + '.' + key;
	m.start();
};
Cadvisor.prototype._sendMetric = function(key, data, timestamp) {
	var self = this;
	if (!this.metrics[key]) {
		this._createMetris(key);
	}
	this.metrics[key].cb(data, (new Date(timestamp)).getTime());

	this.emit(key, data, timestamp);
};
Cadvisor.prototype._loop = function() {
	var self = this;
	this._request('/api/v1.2/docker/' + this.id, function(err, data) {
		var array = data['/system.slice/docker-' + self.id + '.scope'];

		for (var index = 0,
		    j = array.stats.length; index < j; index++) {
			var cur = array.stats[index];

			if (index == 0) {
				continue;
			}
			var time = (new Date(cur.timestamp)).getTime();

			if (time > self.time) {
				var prev = array.stats[index - 1];
				self.time = time;
				self._breakDown(cur, prev);
			}
		};
		self.emit('_loop');
	});
};

Cadvisor.prototype._breakDown = function(cur, prev) {
	var self = this;
	var intervalInNs = getInterval(cur.timestamp, prev.timestamp);
	var intervalInSec = getInterval(cur.timestamp, prev.timestamp) / 1000000000;

	this._sendMetric('memory.usage', (cur.memory.usage), cur.timestamp);
	this._sendMetric('memory.working_set', (cur.memory.working_set), cur.timestamp);

	this._sendMetric('cpu.total', (cur.cpu.usage.total - prev.cpu.usage.total) / intervalInNs, cur.timestamp);

	for (var j = 0; j < this.machine.num_cores; j++) {
		this._sendMetric('cpu.core.' + j, (cur.cpu.usage.per_cpu_usage[j] - prev.cpu.usage.per_cpu_usage[j]) / intervalInNs, cur.timestamp);
	}

	this._sendMetric('cpu.user', (cur.cpu.usage.user - prev.cpu.usage.user) / intervalInNs, cur.timestamp);
	this._sendMetric('cpu.system', (cur.cpu.usage.system - prev.cpu.usage.system) / intervalInNs, cur.timestamp);

	this._sendMetric('network.tx_bytes', (cur.network.tx_bytes - prev.network.tx_bytes) / intervalInSec, cur.timestamp);
	this._sendMetric('network.rx_bytes', (cur.network.rx_bytes - prev.network.rx_bytes) / intervalInSec);

	this._sendMetric('network.tx_errors', (cur.network.tx_errors - prev.network.tx_errors) / intervalInSec, cur.timestamp);
	this._sendMetric('network.rx_errors', (cur.network.rx_errors - prev.network.rx_errors) / intervalInSec, cur.timestamp);

	Object.keys(cur.diskio).forEach(function(key) {
		Object.keys(cur.diskio[key][0].stats).forEach(function(key1) {
			var c = cur.diskio[key][0].stats[key1];
			var p = prev.diskio[key][0].stats[key1];

			self._sendMetric(key + '.' + key1.toLowerCase(), (c - p) / intervalInSec, cur.timestamp);
		});
	});
};

Cadvisor.prototype._request = function(path, done) {
	var req = hyperquest(this.host + path);
	req.on('error', done);
	req.on('response', function(res) {
		res.pipe(concat(function(body) {
			body = body.toString();
			if (res.statusCode == 200) {
				if (body.charAt(0) == '{') {
					done(null, JSON.parse(body));
				} else {
					done(body);
				}
			} else {
				done(res.statusCode + ': ' + body);
			}
		}));
	});
};
module.exports = Cadvisor;
