#!/usr/bin/env node

"use strict";

var gith = require('gith'),
    request = require('superagent'),
    nconf = require('nconf'),
    when = require('when'),
    sequence = require('sequence'),
    bouncy = require('bouncy');


nconf.argv()
    .env()
    .use('memory')
    .file({ file: process.env.PWD + '/config.json' });




function Repo(name, hooks){
    this.name = name;
    this.hooks = hooks;
}

Repo.prototype.hasHook = function(url){
    return this.hooks.some(function(hook){
        return hook.config.url === url;
    });
};

Repo.prototype.addHook = function(url){
    var hook = {
            'name': 'web',
            'active': true,
            'config': {
                'content_type': 'form',
                'insecure_ssl': '1',
                'url': url
            }
        },
        hookString = JSON.stringify(hook),
        d = when.defer();
    request
        .post("https://api.github.com/repos/" + this.name + "/hooks?access_token=" + nconf.get('token'))
        .send(hookString)
        .set("Content-Type", "application/x-www-form-urlencoded")
        .set("Content-Length", hookString.length)
        .end(function (res){
            console.log('Added repo?', res.ok);
            return (res.ok) ? d.resolve(res) : d.reject(res);
        });
    return d.promise;
};

Repo.prototype.ensureHook = function(url){
    var d = when.defer(),
        self = this;

    if(this.hasHook(url)){
        return d.resolve(self);
    }
    this.addHook(url).then(function(){
        return Repo.load(self.name);
    }).then(d.resolve);

    return d.promise;
};

function getWebhooks(repoName){
    var d = when.defer();
    request.get("https://api.github.com/repos/" + repoName + "/hooks?access_token=" + nconf.get('token'))
        .end(function(res){
            d.resolve(res);
        });
    return d.promise;
}

Repo.load = function(name){
    return getWebhooks(name).then(function(res){
        return new Repo(name, res.body);
    });
};

var REPOS = {};

function init(cb){
    sequence().then(function(next){
        when.all(nconf.get('repos').map(function(name){
            return Repo.load(name);
        }), next);
    }).then(function(next, repos){
        when.all(repos.map(function(repo){
            return repo.ensureHook(nconf.get('url'));
        }), next);
    }).then(function(next, repos){
        repos.forEach(function(repo){
            repo.gith = gith({
                repo: repo.name
            });

            REPOS[repo.name] = repo;
        });
        next(repos);
    }).then(function(next, repos){
        cb(repos);
    });
}

init(function(){
    REPOS['exfm/albumart'].gith.on('all', function(payload){
        console.log('Got payload ', payload);
    });
});

gith = gith.create(10000);


function sendChat(msg){
    var d = when.defer();
    request
        .post(nconf.get('post_url'))
        .send({'msg': msg})
        .set("Content-Type", "application/x-www-form-urlencoded")
        .end(function (res){
            return (res.ok) ? d.resolve(res) : d.reject(res);
        });
    return d.promise;
}

var express = require('express'),
    http = require('http');

var app = express();

app.configure(function(){
  app.set('port', 12000);
  app.set('views', __dirname + '/views');
  app.set('view engine', 'jade');
  app.use(express.favicon());
  app.use(express.bodyParser());
  app.use(express.methodOverride());
  app.use(app.router);
});

app.configure('development', function(){
  app.use(express.errorHandler());
});

var commands = {};

function Command(name, description, cb){
    this.name = name;
    this.description = description;
    this.cb = cb;
}

Command.prototype.exec = function(from, args){
    return this.cb.apply(this, [from, args]);
};

Command.prototype.send = function(msg){
    sendChat(msg);
    return msg;
};

function command(name, descrip, cb){
    commands[name] = new Command(name, descrip, cb);
}

command('list', 'List all commands', function(from, args){
    var msg = [];
    if(args.length > 0 && args[0] === 'unknown'){
        msg.push('Unkown command ' + args[1]);
        msg.push('');
    }

    msg.push('Available commands:');
    for(var name in commands){
        msg.push("    "+name + " - " + commands[name].description);
    }
    return this.send(msg.join("\n"));
});

var createSSH = require('ssh-client');

command('deploy', 'Deploy something somewhere.  repo host', function(from, args){
    var self = this,
        client = createSSH('ubuntu', args[1], function(){
            self.send("deploying " + args[0] + " to " + args[1] + '...');
        client.cd('~/apps/', function(){
            var cmd = 'if [ ! -d "'+args[0]+'" ]; then git clone git://github.com/'+nconf.get('github_username')+'/'+args[0]+'.git;fi;cd ' + args[0] + '; git pull';
            console.log(cmd);
            client.exec(cmd, function(){
                client.exec("npm install; forever stop index.js; forever start -l /home/ubuntu/apps/"+args[0]+".log index.js", function(){
                    self.send("deployed " + args[0] + " to " + args[1] + '! Logging at /home/ubuntu/apps/'+args[0]+'.log');
                    client.close();
                });
            });
        });
    });
});

command('echo', 'Just spit it back', function(from, args){
    return this.send(args.join(" "));
});

function runCommand(cmd, from, args){
    console.log(cmd, from, args);
    if(commands.hasOwnProperty(cmd)){
        return commands[cmd].exec(from, args);
    }
    return commands.list.exec(from, ['unknown', cmd]);
}

app.all('/', function(req, res){
    var p = req.param('body', 'nothing').split(' '),
        cmd = p[0],
        extras = p.splice(1);

    return res.send(runCommand(cmd, req.param('from'), extras));
});

http.createServer(app).listen(app.get('port'), function(){
  console.log("Express server listening on port " + app.get('port'));
});

bouncy(function (req, bounce) {
    if(req.url === '/gith' && req.method === 'POST'){
        return bounce(10000);
    }
    return bounce(12000);
}).listen(11000);

process.stdin.on('data', function(data){
    var p = data.toString().replace("\n", "").split(' '),
        cmd = p[0],
        args = p.splice(1);
    console.log(runCommand(cmd, 'shell', args));
});

process.openStdin();