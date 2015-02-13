var Cadvisor = require('../lib/cadvisor')

var cadvisor = new Cadvisor({
	id : '2ff6b52d328cf55dc98ce5e924afd959dea20aaeee6b61e569e23e8641a918bb',
	protocol : 'http://',
	host : '127.0.0.1',
	port : 8080,
	interval : 1000,
	metrics : {
		"port" : 4001,
		"host" : "127.0.0.1"
	}
});

cadvisor.once('tokens', function(tokens) {
	console.log(tokens);
});

cadvisor.start();
