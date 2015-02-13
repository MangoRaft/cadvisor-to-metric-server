var hyperquest = require('hyperquest')
var concat = require('concat-stream')
var os = require('os')

function bytesToSize(bytes) {
	if (bytes == 0)
		return '0 Byte';
	var k = 1000;
	var sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
	var i = Math.floor(Math.log(bytes) / Math.log(k));
	return (bytes / Math.pow(k, i)).toPrecision(3) + ' ' + sizes[i];
}

function getInterval(current, previous) {
	var cur = new Date(current);
	var prev = new Date(previous);

	// ms -> ns.
	return (cur.getTime() - prev.getTime()) * 1000000;
}

function request(path, done) {
	var req = hyperquest('http://' + path);
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
}

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

var id = '2ff6b52d328cf55dc98ce5e924afd959dea20aaeee6b61e569e23e8641a918bb'

function getMetrics(cur, prev, machineInfo) {
	console.log((new Date(cur.timestamp)).getTime()> (new Date(prev.timestamp)).getTime())
	var intervalInNs = getInterval(cur.timestamp, prev.timestamp);
	var intervalInSec = getInterval(cur.timestamp, prev.timestamp) / 1000000000;

	console.log('memory.usage', humanizeMetric(cur.memory.usage))
	console.log('memory.working_set', humanizeMetric(cur.memory.working_set))

	console.log('cpu.total', (cur.cpu.usage.total - prev.cpu.usage.total) / intervalInNs);

	for (var j = 0; j < machineInfo.num_cores; j++) {
		console.log('cpu.core.' + j, (cur.cpu.usage.per_cpu_usage[j] - prev.cpu.usage.per_cpu_usage[j]) / intervalInNs);
	}

	console.log('cpu.user', (cur.cpu.usage.user - prev.cpu.usage.user) / intervalInNs);
	console.log('cpu.system', (cur.cpu.usage.system - prev.cpu.usage.system) / intervalInNs);

	console.log('network.tx_bytes', (cur.network.tx_bytes - prev.network.tx_bytes) / intervalInSec);
	console.log('network.rx_bytes', (cur.network.rx_bytes - prev.network.rx_bytes) / intervalInSec);

	console.log('network.tx_errors', (cur.network.tx_errors - prev.network.tx_errors) / intervalInSec);
	console.log('network.rx_errors', (cur.network.rx_errors - prev.network.rx_errors) / intervalInSec);

	Object.keys(cur.diskio).forEach(function(key) {
		Object.keys(cur.diskio[key][0].stats).forEach(function(key1) {
			var c = cur.diskio[key][0].stats[key1];
			var p = prev.diskio[key][0].stats[key1];

			console.log(key + '.' + key1.toLowerCase(), (c - p) / intervalInSec);
		});
	});
}

request('127.0.0.1:8080/api/v1.0/machine', function(err, machineInfo) {
	//console.log(machineInfo)
	request('127.0.0.1:8080/api/v1.2/docker/' + id, function(err, data) {

		var current = data['/system.slice/docker-' + id + '.scope']

		var cur = current.stats[current.stats.length - 1]
		var prev = current.stats[current.stats.length - 2]
		getMetrics(cur, prev, machineInfo)
	});
});
