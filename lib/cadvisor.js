var util = require('util');
var fs = require('fs');
var net = require('net');
var path = require('path');
var events = require('events');
var os = require('os');
var async = require('async');
var hyperquest = require('hyperquest');
var concat = require('concat-stream');
var StatsD = require('node-statsd');

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
	this.times = {};
	this.timeRoot = 0;
	this.name = options.name;
	this.session = options.session;
	this.metrics = {};
	this.machine = null;
	this.root = options.root || false;
	this.timmer = 0;
	this.interval = options.interval;
	this.host = options.protocol + options.host + ':' + options.port;

	this.client = new StatsD(options.metrics);
};
//
// Inherit from `events.EventEmitter`.
//
util.inherits(Cadvisor, events.EventEmitter);

Cadvisor.prototype.start = function() {
	var self = this;

	this.once('_machine', function(machine) {
		self._timmer();
	});
	this._machine();

};

Cadvisor.prototype.stop = function() {

};

Cadvisor.prototype._timmer = function() {
	var self = this;
	if (this.timmer == 0) {
		this.timmer = setInterval(function() {
			self._loop(true);
		}, this.interval || 5000);
		this.timmer = setInterval(function() {
			self._loop(false);
		}, this.interval || 5000);
	}
};
Cadvisor.prototype._machine = function() {
	var self = this;
	this._machineRequest(function(err, machineInfo) {
		self.machine = machineInfo;
		self.emit('_machine', machineInfo);
	});
};
Cadvisor.prototype._sendMetric = function(key, data, name, root) {
	var self = this;

	if (root) {
		//console.log('cadvisor.system.' + name + '.' + key, data)
		this.client.increment('cadvisor.system.' + name + '.' + key, data);
	} else {
		//console.log('cadvisor.user.' + name + '.' + key)
		this.client.increment('cadvisor.user.' + name + '.' + key, data);
	}

};

Cadvisor.prototype._loop = function(root) {
	var self = this;

	function onResponce(err, data) {

		if (err)
			return self.emit('error', err);

		function loop(array, name) {
			if (!self.times[name]) {
				self.times[name] = 0;
			}
			for (var index = 0,
			    j = array.stats.length; index < j; index++) {
				var cur = array.stats[index];

				if (index == 0) {
					continue;
				}
				var time = (new Date(cur.timestamp)).getTime();

				if (time > self.times[name]) {
					var prev = array.stats[index - 1];
					self.times[name] = time;
					self._breakDown(cur, prev, name, root);
				}
			};
		}

		if (root) {
			var array = data;
			var name = self.name;
			loop(array, name);
		} else {
			Object.keys(data).forEach(function(key) {
				var array = data[key];
				var name = self.name + '.' + array.aliases.shift().split('-').join('.');
				loop(array, name);
			});
		}

	}

	if (root)
		this._statsRootRequest(onResponce);
	else
		this._statsRequest(onResponce);
};

Cadvisor.prototype._breakDown = function(cur, prev, name, root) {
	var self = this;

	var intervalInNs = getInterval(cur.timestamp, prev.timestamp);
	var intervalInSec = getInterval(cur.timestamp, prev.timestamp) / 1000000000;

	this._sendMetric('memory.usage', (cur.memory.usage), name, root);
	this._sendMetric('memory.working_set', (cur.memory.working_set), name, root);

	this._sendMetric('cpu.total', (cur.cpu.usage.total - prev.cpu.usage.total) / intervalInNs, name, root);

	for (var j = 0; j < this.machine.num_cores; j++) {
		this._sendMetric('cpu.core.' + j, (cur.cpu.usage.per_cpu_usage[j] - prev.cpu.usage.per_cpu_usage[j]) / intervalInNs, name, root);
	}

	this._sendMetric('cpu.user', (cur.cpu.usage.user - prev.cpu.usage.user) / intervalInNs, name, root);
	this._sendMetric('cpu.system', (cur.cpu.usage.system - prev.cpu.usage.system) / intervalInNs, name, root);

	Object.keys(cur.network).forEach(function(key) {
		self._sendMetric('network.' + key.split('_').join('.'), (cur.network[key] - prev.network[key]) / intervalInSec, name, root);
	});
	Object.keys(cur.diskio).forEach(function(key) {
		Object.keys(cur.diskio[key][0].stats).forEach(function(key1) {
			var c = cur.diskio[key][0].stats[key1];
			var p = prev.diskio[key][0].stats[key1];

			var key2 = key.split('_');
			key2 = key2.shift() + '.' + key2.join('_');

			if (c <= p)
				self._sendMetric(key2 + '.' + key1.toLowerCase(), 0, name, root);
			else
				self._sendMetric(key2 + '.' + key1.toLowerCase(), (c - p) / intervalInSec, name, root);
		});
	});
};

Cadvisor.prototype._statsRequest = function(done) {
	var path = this.host + '/api/v1.2/docker';
	var req = hyperquest.post(path);
	req.on('error', done);
	req.on('response', function(res) {
		res.pipe(concat(function(body) {
			body = body.toString();
			if (res.statusCode == 200) {
				if (body.charAt(0) == '{') {

					var json = JSON.parse(body)

					done(null, json);
				} else {
					done(body);
				}
			} else {
				done(res.statusCode + ': ' + body);
			}
		}));
	});
	req.end(JSON.stringify({
		"num_stats" : (this.interval / 1000) + 1
	}));
};
Cadvisor.prototype._statsRootRequest = function(done) {
	var path = this.host + '/api/v1.0/containers/';

	var req = hyperquest.post(path);
	req.on('error', done);
	req.on('response', function(res) {
		res.pipe(concat(function(body) {
			body = body.toString();
			if (res.statusCode == 200) {
				if (body.charAt(0) == '{') {

					var json = JSON.parse(body)

					done(null, json);
				} else {
					done(body);
				}
			} else {
				done(res.statusCode + ': ' + body);
			}
		}));
	});
	req.end(JSON.stringify({
		"num_stats" : (this.interval / 1000) + 1
	}));
};

Cadvisor.prototype._machineRequest = function(done) {
	var req = hyperquest(this.host + '/api/v1.0/machine');
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
