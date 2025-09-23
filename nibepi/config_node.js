// Instructions:
    // MAKE SURE YOU HAVE TURNED OFF READ-ONLY MODE IN NIBEPI UI
// 1. SSH into your nibepi (ssh pi@<nibepiIP>; password: nibe)
// 2. Make a backup of config_node.js (cp /home/pi/.node-red/node_modules/node-red-contrib-nibepi/config_node.js /home/pi/.node-red/node_modules/node-red-contrib-nibepi/config_node_backup.js)
// 3. Remove config_node.js (rm /home/pi/.node-red/node_modules/node-red-contrib-nibepi/config_node.js)
// 4. Create a new config_node.js (nano /home/pi/.node-red/node_modules/node-red-contrib-nibepi/config_node.js)
// 5. Paste the code from GitHub (https://github.com/martinarva/homeautomation/blob/main/nibepi/config_node.js)
// 6. Modify the Home Assistant settings at the top of the file:
//     • HA_BASE_URL: the full URL to your Home Assistant (include protocol and port). Example: http://192.168.1.50:8123/ or https://homeassistant.local:8123/
//     • HA_TOKEN: a Home Assistant long-lived access token. Create one under your HA profile → Security → Long-lived access tokens, then paste the token string.
//     • HA_ENTITY: the entity_id of your Nordpool integration (or template sensor). Example: sensor.nordpool_kwh_ee_eur_97_10_0
//     • PRICE_TO_CENTS_MULTIPLIER: use 100 if your Nordpool sensor reports €/kWh and you want cents/öre. Adjust if your source already reports in cents/öre.
// 7. Save the file (CTRL + X in nano)
// 8. Restart Node-RED from the nibepi UI



module.exports = function(RED) {
    const EventEmitter = require('events').EventEmitter;
    require('events').EventEmitter.defaultMaxListeners = 800;
    const https = require('https');
    const http = require('http');
    const nibeData = new EventEmitter()
    const nibe = require('nibepi')
    var serialPort = "";
    var tcp_host = "";
    var tcp_port = "";
    let text = require('./language-SE.json')
    let translate = require('./translate.json')
    var series = "";
    var systems = {};
    let adjust = [];
    let hP;
    let weatherOffset = {};
    let indoorOffset = {};
    let priceOffset = {};
    let savedGraph = {};
    let savedData = {};

    // ======== HOME ASSISTANT SETTINGS ========
    // Edit these values to match your own Home Assistant setup
    // -------------------------------------------
    // HA_BASE_URL: the full URL to your Home Assistant (include protocol & port).
    //    Example: "http://192.168.1.50:8123" or "https://homeassistant.local:8123"
    // HA_TOKEN: a Home Assistant long-lived access token.
    //    Create one under your HA profile → Security → Long-lived access tokens.
    //    Paste the token string between the quotes below.
    // HA_ENTITY: the entity_id of your Nord Pool integration (or template sensor).
    //    Example: "sensor.nordpool_kwh_ee_eur_97_10_0"
    // PRICE_TO_CENTS_MULTIPLIER: use 100 if your Nord Pool sensor gives €/kWh and you want cents/öre.
    //    Adjust if your source already reports in cents/öre.

    const HA_BASE_URL = "http://HOME_ASSISTANT_URL:8123";
    const HA_TOKEN    = "YOUR_LONG_LIVED_ACCESS_TOKEN_HERE";
    const HA_ENTITY   = "sensor.YOUR_NORDPOOL_SENSOR";
    const PRICE_TO_CENTS_MULTIPLIER = 100;


    // Small helper to GET the HA entity state+attributes (with verbose logging)
    function fetchHAEntity(entityId) {
    return new Promise((resolve, reject) => {
        const url = `${HA_BASE_URL}/api/states/${encodeURIComponent(entityId)}`;
        const u = new URL(url);

        // 1) Call started
        if (nibe && typeof nibe.log === "function") {
        nibe.log(`HA fetch start: ${u.href}`, "price", "debug");
        }

        const options = {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + (u.search || ""),
        method: "GET",
        headers: { "Authorization": `Bearer ${HA_TOKEN}`, "Accept": "application/json" },
        timeout: 8000
        };

        const client = (u.protocol === "https:") ? require("https") : require("http");
        const req = client.request(options, (res) => {
        // 2) Got response
        if (nibe && typeof nibe.log === "function") {
            nibe.log(`HA response: ${res.statusCode} ${res.statusMessage || ""}`, "price", "debug");
        }

        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
            try {
            if (res.statusCode !== 200) {
                if (nibe && typeof nibe.log === "function") {
                nibe.log(`HA non-200 body (first 200): ${String(data).slice(0,200)}`, "price", "debug");
                }
                return reject(new Error(`HA ${res.statusCode}: ${res.statusMessage || ""}`));
            }

            // 3) Try parse
            let obj;
            try {
                obj = JSON.parse(data);
            } catch (e) {
                if (nibe && typeof nibe.log === "function") {
                nibe.log(`HA JSON parse error: ${e.message}. Raw (first 200): ${String(data).slice(0,200)}`, "price", "error");
                }
                return reject(e);
            }

            // 4) Join raw_today + raw_tomorrow -> raw_all
            const attrs = obj && obj.attributes ? obj.attributes : (obj.attributes = {});
            const today    = Array.isArray(attrs.raw_today) ? attrs.raw_today : [];
            const tomorrow = Array.isArray(attrs.raw_tomorrow) ? attrs.raw_tomorrow : [];
            attrs.raw_all  = [...today, ...tomorrow].filter(p => p && p.start);

            attrs.raw_all.sort((a, b) => new Date(a.start) - new Date(b.start));

            // 5) Log the join result
            if (nibe && typeof nibe.log === "function") {
                const windowStr = attrs.raw_all.length
                ? `${attrs.raw_all[0].start} → ${attrs.raw_all[attrs.raw_all.length - 1].end || attrs.raw_all[attrs.raw_all.length - 1].start}`
                : "(empty)";
                nibe.log(
                `HA join: today=${today.length}, tomorrow=${tomorrow.length}, total=${attrs.raw_all.length}, window=${windowStr}`,
                "price", "debug"
                );
            }

            resolve(obj);
            } catch (e) {
            if (nibe && typeof nibe.log === "function") {
                nibe.log(`HA fetch processing error: ${e.message}`, "price", "error");
            }
            reject(e);
            }
        });
        });

        req.on("timeout", () => {
        if (nibe && typeof nibe.log === "function") {
            nibe.log("HA request timed out", "price", "error");
        }
        req.destroy(new Error("HA request timed out"));
        });

        req.on("error", (err) => {
        if (nibe && typeof nibe.log === "function") {
            nibe.log(`HA request error: ${err.message}`, "price", "error");
        }
        reject(err);
        });

        req.end();
    });
    }    

    const SunCalc = require('suncalc');
    const suncalc = (data) => {
        var times = SunCalc.getTimes(data.timestamp, data.lat, data.lon);
        return times;
    }
    const toTimestamp = (strDate) => {
        var datum = Date.parse(strDate);
        return Number((datum).toFixed());
    }
    const initiateCore = (host,port,cb) => {
        nibe.initiateCore(host,port, (err,data) => {
            if(err) console.log(err);
            nibe.core = data;
            cb(null,true);
        });
    }
    let timer = {};
    function updateConfig(category,parameter,data) {
        let config = nibe.getConfig();
        if(config[category]!==undefined && config[category][parameter]!==undefined) {
            if(config[category][parameter]!==data) {
                config[category][parameter] = data;
                // Config has changed
                nibeData.emit(`config_${category}`,config[category]);
                nibe.setConfig(config);
            }
        }
    }
    const curveAdjust = (type,system,data) => {
        let curveadjust;
        if(hP!==undefined) {
            curveadjust = hP['curveadjust_'+system];
        }
        var newSystem = true;
        for( var i = 0; i < adjust.length; i++){
            if(adjust[i].system===system) {
                let newType = true;
                let newData = false;
                for( var o = 0; o < adjust[i].data.length; o++){
                    if(adjust[i].data[o].name===type) {
                        adjust[i].data[o].data = data;
                        newType = false;
                        newData = true;
                    }
                }
                if(newType===true) {
                    adjust[i].data.push({name:type,data:data});
                }
                if(newData===true) {
                    // Set new curveadjust
                    let out = 0;
                    let run = false;
                    if(timer[system]!==undefined && timer[system]._idleTimeout>0) {
                        clearTimeout(timer[system]);
                        run = true;
                    } else {
                        run = true;
                    }
                    if(run===true) {
                        timer[system] = setTimeout((i) => {
                            for( var o = 0; o < adjust[i].data.length; o++){
                                out = out+adjust[i].data[o].data;
                            }
                            out = out;
                            nibe.reqData(curveadjust).then(result => {
                                let config = nibe.getConfig();
                                if(config.home===undefined) {
                                    config.home = {};
                                    nibe.setConfig(config);
                                }
                                if(config.home['adjust_'+system]!==undefined) {
                                    out = out+Number(config.home['adjust_'+system]);
                                }
                                if(out>10) out = 10;
                                if(out<-10) out = -10;
                                if(out>(result.data+0.75)) {
                                    out = Math.round(out);
                                    if(result.data!==(out)) {
                                        nibe.setData(curveadjust,out,(err,result) => {
                                            if(err) return console.log(err);
                                            let save = {
                                                titel:"Curveadjustment",
                                                register:'curveadjust',
                                                info:"NibePis total adjustment of the curve",
                                                raw_data:out,
                                                data:out,
                                                unit:"°C",
                                                icon_name:"fa-thermometer-three-quarters"
                                            }
                                            savedData['curveadjust'] = save;
                                            saveDataGraph('curveadjust',Date.now(),save.raw_data)
                                        });
                                    }
                                } else if(out<(result.data-0.75)) {
                                    out = Math.round(out);
                                    if(result.data!==(out)) {
                                        nibe.setData(curveadjust,out,(err,result) => {
                                            if(err) return console.log(err);
                                            let save = {
                                                titel:"Curveadjustment",
                                                register:'curveadjust',
                                                info:"NibePis total adjustment of the curve",
                                                raw_data:out,
                                                data:out,
                                                unit:"°C",
                                                icon_name:"fa-thermometer-three-quarters"
                                            }
                                            savedData['curveadjust'] = save;
                                            saveDataGraph('curveadjust',Date.now(),save.raw_data)
                                        });
                                    }
                                }
                            }).catch(console.log)
                                
                        }, 5000,i);
                    }
                }
                newSystem = false;
            }
        }
        if(newSystem===true) {
            adjust.push({system:system,data:[{name:type,data:data}]})
            curveAdjust(type,system,data);
        }
    }
    const getList = [];
    function clearList(plugin,system) {
        const promise = new Promise((resolve,reject) => {
            for( var i = 0; i < getList.length; i++){
                if(getList[i].system===system) {
                    for( var j = 0; j < getList[i].registers.length; j++){
                        if(getList[i].registers[j].plugin!==undefined) {
                            let len = getList[i].registers[j].plugin.length;
                            for( var k = 0; k <len ; k++){
                                if(getList[i].registers[j].plugin[k]===plugin) {
                                    getList[i].registers[j].plugin.splice(k,1);
                                    if(getList[i].registers[j].plugin.length===0) {
                                        getList[i].registers.splice(j,1);
                                    }
                                }
                            }
                        }
                        
                    }
                }
            }
            
            resolve(true);
        });
        return promise;
    }
    async function initiatePlugin(arrData,plugin,system="s1") {
        let arr = arrData.slice();
        const promise = new Promise((resolve,reject) => {
            clearList(plugin,system).then(result => {
                var newSystem = true;
                
                for( var i = 0; i < arr.length; i++){
                    if(arr[i].register===undefined) {
                        arr[i].register = hP[arr[i].topic];
                    }
                    for( var o = 0; o < getList.length; o++){
                        
                        if(getList[o].system===system) {
                            // System exists, moving on.
                            newSystem = false;
                                // Looking for the register from the incoming array.
                                let regI = getList[o].registers.findIndex(regI => regI.register == arr[i].register);
                                if(regI===-1) {
                                    // Register dont exist, adding new register.
                                    let newArr = arr[i];
                                    // Adding the plugin name to the first array
                                    newArr.plugin = [plugin];
                                    getList[o].registers.push(newArr);
                                } else {
                                    // The register already exists, checking if the plugin is already added and gets the index.
                                    let regP = getList[o].registers[regI].plugin.findIndex(regP => regP == plugin);
                                    if(getList[o].registers[regI].name===undefined) getList[o].registers[regI].name = arr[i].name;
                                    if(getList[o].registers[regI].topic===undefined) getList[o].registers[regI].topic = arr[i].topic;
                                    if(regP===-1) {
                                        getList[o].registers[regI].plugin.push(plugin);
                                    } else {

                                    }
                                }
                            
                        }
                    }
                }
                let checkReg = hP['supply_'+system];
                function checkRMU() {
                    if(plugin=="rmu") {
                        nibe.reqData(hP['startHW_rmu_'+system]).then(data => {
                            if(data!==undefined) {
                                let regN = getList.findIndex(regN => regN.system == 's1');
                                if(regN!==-1) {
                                for( var i = 0; i < arr.length; i=i+1){
                                    let regI = getList[regN].registers.findIndex(regI => regI.register == arr[i].register);
                                    if(regI===-1) {
                                        let newArr = arr[i];
                                        newArr.plugin = [plugin];
                                        getList[regN].registers.push(newArr);
                                    } else {
                                        if(getList[regN].registers[regI].topic===undefined) getList[regN].registers[regI].topic = arr[i].topic;
                                        if(getList[regN].registers[regI].name===undefined) getList[regN].registers[regI].name = arr[i].name;
                                        let regP = getList[regN].registers[regI].plugin.findIndex(regP => regP == plugin);
                                        if(regP===-1) {
                                            getList[regN].registers[regI].plugin.push(plugin);
                                        } else {

                                        }
                                    }
                                    }
                                }
                                resolve(true)
                            } else {
                                return reject(false); 
                            }
                        }).catch((err) => {
                            return reject(false)
                        })
                    } else {
                        //sendError('System',`System S${system.replace('s','')} ${text.sys_not_connected}`);
                        //return reject(false);
                    }
                }
                if(newSystem===true) {
                    let regN = getList.findIndex(regN => regN.system == system);
                    if(regN===-1) {
                        checkRMU();
                        nibe.reqData(checkReg).then(data => {
                            if(data.data<-3276) {
                                checkRMU();
                                return reject(false);
                            } else {
                                systems[system] = true;
                                if(plugin=="fan") {
                                    nibe.reqData(hP.bs1_flow).then(data => {
                                        if(data.data<-3276) {
                                            return reject(false);
                                        } else {
                                            let regN = getList.findIndex(regN => regN.system == system);
                                if(regN===-1) {
                                    getList.push({system:system,registers:[]});
                                    for( var i = 0; i < arr.length; i=i+1){
                                        let regI = getList.findIndex(regI => regI.system == system);
                                        let newArr = arr[i];
                                        newArr.plugin = [plugin];
                                        getList[regI].registers.push(newArr);
                                    }
                                } else {
                                    for( var i = 0; i < arr.length; i=i+1){
                                    let regI = getList[regN].registers.findIndex(regI => regI.register == arr[i].register);
                                    if(regI===-1) {
                                        let newArr = arr[i];
                                        newArr.plugin = [plugin];
                                        getList[regN].registers.push(newArr);
                                    } else {
                                        if(getList[regN].registers[regI].topic===undefined) getList[regN].registers[regI].topic = arr[i].topic;
                                        if(getList[regN].registers[regI].name===undefined) getList[regN].registers[regI].name = arr[i].name;
                                        let regP = getList[regN].registers[regI].plugin.findIndex(regP => regP == plugin);
                                        if(regP===-1) {
                                            getList[regN].registers[regI].plugin.push(plugin);
                                        } else {

                                        }
                                    }
                                    }
                                }
                                resolve(true)
                                        }
                                    },(error => {
                                        return reject(false);
                                    }));
                            } else {
                                let regN = getList.findIndex(regN => regN.system == system);
                                if(regN===-1) {
                                    getList.push({system:system,registers:[]});
                                    for( var i = 0; i < arr.length; i=i+1){
                                        let regI = getList.findIndex(regI => regI.system == system);
                                        let newArr = arr[i];
                                        newArr.plugin = [plugin];
                                        getList[regI].registers.push(newArr);
                                    }
                                } else {
                                    for( var i = 0; i < arr.length; i=i+1){
                                    let regI = getList[regN].registers.findIndex(regI => regI.register == arr[i].register);
                                    if(regI===-1) {
                                        let newArr = arr[i];
                                        newArr.plugin = [plugin];
                                        getList[regN].registers.push(newArr);
                                    } else {
                                        if(getList[regN].registers[regI].topic===undefined) getList[regN].registers[regI].topic = arr[i].topic;
                                        if(getList[regN].registers[regI].name===undefined) getList[regN].registers[regI].name = arr[i].name;
                                        let regP = getList[regN].registers[regI].plugin.findIndex(regP => regP == plugin);
                                        if(regP===-1) {
                                            getList[regN].registers[regI].plugin.push(plugin);
                                        } else {

                                        }
                                    }
                                    }
                                }
                                resolve(true)
                            }
                                
                            }
                        }).catch((err) => {
                            checkRMU();
                            return reject(false);
                        });
                        
                    } else {
                        checkRMU();
                        nibe.reqData(checkReg).then(data => {
                            if(data.data<-3276) {
                                checkRMU();
                                return reject(false);
                            } else {
                                systems[system] = true;
                                if(plugin=="fan") {
                                    nibe.reqData(hP.bs1_flow).then(data => {
                                        if(data.data<-3276) {
                                            return reject(false);
                                        } else {
                                            resolve(true)
                                        }
                                    }).catch((err) => {
                                        return reject(false);
                                    });
                            } else {
                                resolve(true)
                            }
                            }
                        }).catch((err) => {
                            checkRMU();
                            return reject(false);
                        });
                        
                    }
                } else {
                    checkRMU();
                    nibe.reqData(checkReg).then(data => {
                        if(data.data<-3276) {
                            checkRMU();
                            return reject(false);
                        } else {
                            systems[system] = true;
                            if(plugin=="fan") {
                                nibe.reqData(hP.bs1_flow).then(data => {
                                    if(data.data<-3276) {
                                        return reject(false);
                                    } else {
    
                                    }
                                },(error => {
                                    return reject(false);
                                }));
                        } else {
                            resolve(true)
                        }
                        }
                    }).catch((err) => {
                        checkRMU();
                        return reject(false);
                    });
                    
                }
        })
    });
    return promise;
}
    async function updateData(hourly=false) {
        let timeNow = Date.now();
        /*
        Check emitters
        let events = nibeData.eventNames()
        console.log(JSON.stringify(events,null,2));
        for (const item of events) {
            let count = nibeData.listenerCount(item)
            console.log(`Eventname: ${item}, Count: ${count}`);
        }*/
        for (const item of getList) {
            const array = [];
            let result = {timestamp:timeNow};
            result.system = item.system;
            if(weatherOffset[item.system]===undefined) weatherOffset[item.system] = 0;
            if(indoorOffset[item.system]===undefined) indoorOffset[item.system] = 0;
            if(priceOffset[item.system]===undefined) priceOffset[item.system] = 0;
            result.indoorOffset = indoorOffset[item.system];
            result.weatherOffset = weatherOffset[item.system];
            result.priceOffset = priceOffset[item.system];
            for( var i = 0; i < item.registers.length; i++){
                if(item.registers[i].source!==undefined) {
                    if(item.registers[i].source=="mqtt") {
                        await nibe.getMQTTData(item.registers[i].register).then(atad => {
                            let data = Object.assign({}, atad);
                            let config = nibe.getConfig();
                            let sensor_timeout;
                            if(config.home===undefined) {
                                config.home = {};
                                nibe.setConfig(config);
                            }
                            if(config.home.sensor_timeout!==undefined && config.home.sensor_timeout!=="" && config.home.sensor_timeout!==0) {
                                sensor_timeout = data.timestamp+(config.home.sensor_timeout*60000);
                            } else if(config.home.sensor_timeout===0 || config.home.sensor_timeout===undefined || config.home.sensor_timeout==="") {
                                sensor_timeout = timeNow;
                            } else {
                                sensor_timeout = data.timestamp+(60*60000);
                            }
                            if(timeNow>sensor_timeout) {
                                sendError(text.extra_sensor,`${text.extra_sensor} ${item.registers[i].name} ${text.not_updated}`)
                            } else {
                                data.system = item.system;
                                data.timestamp = timeNow;
                                data.name = item.registers[i].name;
                                data.topic = item.registers[i].register;
                                result[item.registers[i].register] = data;
                                array.push(data)
                            }
                            
                        },(error => {
                            sendError(text.extra_sensor,`${text.extra_sensor} ${item.registers[i].name} ${text.no_values}`)
                        }));
                    } else if(item.registers[i].source=="tibber") {
                        console.log('Tibber Data request');
                    } else if(item.registers[i].source=="nibe") {
                            await getNibeData(item.registers[i].register).then(atad => {
                                let data = Object.assign({}, atad);
                                data.system = item.system;
                                data.name = item.registers[i].name;
                                data.topic = item.registers[i].topic;
                                result[item.registers[i].topic] = data;
                                array.push(data)
                            }).catch(console.log)
                    }
                }
            }
            runIndoor(result,array);
            runPrice(result,array);
            runRMU(result,array);
            if(hourly===true) {
                result.array = array;
                runWeather(result);
            } else {
                result.array = array;
                if(nibe.getConfig().weather['enable_'+item.system]===true) {
                    nibeData.emit('pluginWeather',result);
                }
            }
            nibeData.emit('updateGraph');
        }
      }
        const checkWind = (array,hours) => {
        var output = {};
        let config = nibe.getConfig();
        if(config.weather===undefined) {
            config.weather = {};
            nibe.setConfig(config);
        }
          if(config.weather.wind_enable!==undefined && config.weather.wind_enable===true) {
            
            var wind_speed_arr = [];
            var wind_gust_arr = [];
            var temp_arr = [];
            var feel_arr = [];
            var direction_arr = [];
            for( var o = 0; o < 49; o++){
                let timestamp = toTimestamp(array[o].validTime)
                let speed = array[o].parameters.find(speed => speed.name == "ws");
                let dir = array[o].parameters.find(dir => dir.name == "wd");
                let gust = array[o].parameters.find(gust => gust.name == "gust");
                let temp = array[o].parameters.find(temp => temp.name == "t");
                speed = speed.values[0];
                gust = gust.values[0];
                temp = temp.values[0];
                dir = dir.values[0];
                let direction = 0;
                let factor = 1;
                if(((1 <= dir) && (dir <= 45)) || ((315 <= dir) && (dir <= 360))) {
                    direction = -1;
                    if(config.weather.wind_factor_n===undefined) config.weather.wind_factor_n = 0; nibe.setConfig(config);
                    factor = config.weather.wind_factor_n;
                } else if(136 <= dir && dir <= 225) {
                    direction = -2;
                    if(config.weather.wind_factor_s===undefined) {config.weather.wind_factor_s = 0; nibe.setConfig(config);}
                    factor = config.weather.wind_factor_s;
                } else if(226 <= dir && dir <= 314) {
                    direction = -3;
                    if(config.weather.wind_factor_w===undefined) {config.weather.wind_factor_w = 0; nibe.setConfig(config);}
                    factor = config.weather.wind_factor_w;
                } else if(46 <= dir && dir <= 135) {
                    direction = -4;
                    if(config.weather.wind_factor_e===undefined) {config.weather.wind_factor_e = 0; nibe.setConfig(config);}
                    factor = config.weather.wind_factor_e;
                }
                let v = Math.pow(speed, 0.16);
                feel = Number((13.12+(0.6215*temp)-(13.956*v)+(0.48669*temp*v)).toFixed(2));
                if(feel>0) {
                    feel = Number((feel/factor).toFixed(2));
                    if(feel>temp) {
                        feel = temp;
                    }
                } else {
                    feel = Number((feel*factor).toFixed(2));
                    if(feel>temp) {
                        feel = temp;
                    }
                }
                if(speed<2 || temp>10 || speed>35 || direction===0) feel = temp;
                wind_speed_arr.push({x:timestamp,y:Number(speed)});
                wind_gust_arr.push({x:timestamp,y:Number(gust)});
                temp_arr.push({x:timestamp,y:Number(temp)});
                feel_arr.push({x:timestamp,y:feel});
                direction_arr.push({x:timestamp,y:direction});
                    if(o===hours) {
                        output.feel = feel;
                    }
            }
                wind_speed_arr.sort((a, b) => (a.x > b.x) ? 1 : -1)
                wind_gust_arr.sort((a, b) => (a.x > b.x) ? 1 : -1)
                temp_arr.sort((a, b) => (a.x > b.x) ? 1 : -1)
                feel_arr.sort((a, b) => (a.x > b.x) ? 1 : -1)
                direction_arr.sort((a, b) => (a.x > b.x) ? 1 : -1)
                output.graph = [
                    {
                        "series":["Vindhastighet","Byvind","Utomhustemp","Köldeffekt","Riktning"],
                        "data":[wind_speed_arr,wind_gust_arr,temp_arr,feel_arr,direction_arr],
                        "labels":["Vindhastighet","Byvind","Utomhustemp","Köldeffekt","Riktning"]
                    }];
          } else {
              output.feel = undefined;
              output.graph = [];
          }
            return output;
        }
    const runWeather = async (val) => {
        nibe.log(`Startar Prognosreglering`,'weather','debug');
        let timeNow = Date.now();
        //var val = Object.assign({}, result);
        let config = nibe.getConfig();
        if(config.weather===undefined) {
            config.weather = {};
            nibe.setConfig(config);
        }
        if(config.weather!==undefined && config.weather['enable_'+val.system]===true) {
            if(config.weather.enable_up===undefined) {
                config.weather.enable_up = true
                nibe.setConfig(config);
            }
            if(config.weather.enable_down===undefined) {
                config.weather.enable_down = true
                nibe.setConfig(config);
            }
            let outside = val.outside.data;
            nibe.log(`Aktuell utomhustemperatur: ${outside}`,'weather','debug');
            if(val['heatcurve_'+val.system]===undefined) {
                console.log('Hämtar värmekurva manuellt.')
                val['heatcurve_'+val.system] = await getNibeData(hP['heatcurve_'+val.system]).catch(console.log)
            }
            let heatcurve = val['heatcurve_'+val.system].data;
            nibe.log(`Aktuell värmekurva: ${heatcurve}`,'weather','debug');
            let setOffset = val.weatherOffset;
            let lon = config.home.lon;
            let lat = config.home.lat;
            nibe.log(`Koordinater: (Latitud: ${config.home.lat}, Longitud: ${config.home.lon})`,'weather','debug');
            if(lon!==undefined && lat!==undefined && lon!="" && lat!="") {
                https.get(`https://opendata-download-metfcst.smhi.se/api/category/pmp3g/version/2/geotype/point/lon/${lon}/lat/${lat}/data.json`, (resp) => {
                    let data = '';
                    resp.on('data', (chunk) => {
                    data += chunk;
                    });
                    resp.on('end', () => {
                        if(resp.statusCode===200) {
                            let hours = config.home['hours_'+val.system];
                            let time = Number((Date.now()).toFixed())+(hours*3600000);
                            const astro = suncalc({lat:lat,lon:lon,timestamp:time})
                            var sunrise = toTimestamp(astro.sunrise)/1000;
                            var sunset = toTimestamp(astro.sunset)/1000;
                            var sunTime = Number((Date.now()/1000).toFixed())+(hours*3600);
                            let sun;
                            if(sunTime>sunrise && sunTime<sunset) {
                                nibe.log(`När prognosen infaller är det dag.`,'weather','debug');
                                sun = true;
                            } else {
                                nibe.log(`När prognosen infaller är det inte dag.`,'weather','debug');
                                sun = false;
                            }
                            data = JSON.parse(data);
                            let wind = checkWind(data.timeSeries,hours);
                            let windSet = wind.feel;
                            var tempPredicted = data.timeSeries[hours].parameters.find(tempPredicted => tempPredicted.name == "t");
                            var tempNow = data.timeSeries[0].parameters.find(tempNow => tempNow.name == "t");
                            var weatherPredicted = data.timeSeries[hours].parameters.find(weatherPredicted => weatherPredicted.name == "Wsymb2");
                            tempPredicted = tempPredicted.values[0];
                            weatherPredicted = Number(weatherPredicted.values[0]);
                            var sunFactor = 0;
                            if(config.weather.sun_enable!==undefined && config.weather.sun_enable===true) {
                                nibe.log(`Solfaktor aktiverad`,'weather','debug');
                                if(weatherPredicted===1 && sun===true) {
                                    if(config.weather.clear===undefined) { config.weather.clear = 0; nibe.setConfig(config); }
                                    sunFactor = config.weather.clear;
                                } else if(weatherPredicted===2 && sun===true) {
                                    if(config.weather.mostly_clear===undefined) { config.weather.mostly_clear = 0; nibe.setConfig(config); }
                                    sunFactor = config.weather.mostly_clear;
                                } else if(weatherPredicted===3 && sun===true) {
                                    if(config.weather.half_clear===undefined) { config.weather.half_clear = 0; nibe.setConfig(config); }
                                    sunFactor = config.weather.half_clear;
                                }
                                nibe.log(`Aktuell solfaktor är: ${sunFactor}`,'weather','debug');
                            }
                                    if(outside===undefined || heatcurve===undefined) {
                                        if(outside===undefined) nibe.log(`Saknar värde från utomhusgivare`,'weather','error');
                                        if(heatcurve===undefined) nibe.log(`Saknar värde från värmekurva`,'weather','error');
                                        return;
                                    }
                                    if(heatcurve===0) {
                                        nibe.log(`Prognosreglering fungerar inte med egen värmekurva.`,'weather','error');
                                        return;
                                    }
                                    if(config.weather.forecast_adjust===undefined) {
                                        config.weather.forecast_adjust = false;
                                        nibe.setConfig(config);
                                    }
                                    if(config.weather.forecast_adjust===true) {
                                        val.unfiltredTemp = {payload:tempPredicted,timestamp:toTimestamp(data.timeSeries[hours].validTime)};
                                        saveDataGraph('weather_unfilterd_'+val.system,toTimestamp(data.timeSeries[hours].validTime),tempPredicted,true)
                                        tempPredicted = Number(((outside-(tempNow.values[0]))+tempPredicted).toFixed(2));
                                        if(windSet!==undefined) windSet = Number(((outside-tempNow.values[0])+windSet).toFixed(2));
                                    }
                                    if(config.weather.wind_enable!==undefined && config.weather.wind_enable===true) {
                                        nibe.log(`Vindstyrning aktiverad. Köldeffekt: ${windSet} grader`,'weather','debug');
                                        setOffset = Number(((outside-windSet-sunFactor)*(heatcurve*1.2/10)/((heatcurve/10)+1)).toFixed(2));
                                    } else {
                                        setOffset = Number(((outside-tempPredicted-sunFactor)*(heatcurve*1.2/10)/((heatcurve/10)+1)).toFixed(2));
                                    }
                                    // Lägg in blockering om höjning eller sänkning
                                    nibe.log(`Kollar om det är tillåtet att sänkas eller höjas.`,'weather','debug');
                                    if(setOffset > 0) {
                                        if(config.weather.enable_up===false) {
                                            nibe.log(`Ej tillåtet att höja.`,'weather','debug');
                                            setOffset = 0
                                        }
                                    } else {
                                        if(config.weather.enable_down===false) {
                                            nibe.log(`Ej tillåtet att sänka.`,'weather','debug');
                                            setOffset = 0
                                        }
                                    }
                                    nibe.log(`Utför kurvjustering, värde: ${setOffset}`,'weather','debug');
                                    curveAdjust('weather',val.system,setOffset);
                                    val.windGraph = wind.graph;
                                    val.weatherOffset = setOffset;
                                    weatherOffset[val.system] = setOffset;
                                    val.predictedNow = {payload:tempNow.values[0],timestamp:toTimestamp(data.timeSeries[0].validTime)};
                                    val.predictedLater = {payload:tempPredicted,timestamp:toTimestamp(data.timeSeries[hours].validTime)};
                                    saveDataGraph('weather_forecast_'+val.system,toTimestamp(data.timeSeries[hours].validTime),tempPredicted,true);
                                    nibe.log(`Sparar värde för prognos. (${tempPredicted} grader)`,'weather','debug');
                                    saveDataGraph('weather_offset_'+val.system,timeNow,val.weatherOffset,true);
                                    nibe.log(`Sparar värde för kurvjustering. (${val.weatherOffset})`,'weather','debug');
                                    let inside;
                                    if(config.weather['sensor_'+val.system]!==undefined && config.weather['sensor_'+val.system]!=="") {
                                        let index = val.array.findIndex(i => i.name == config.weather['sensor_'+val.system]);
                                        if(index!==-1) {
                                            inside = val.array[index];
                                        }
                                    }
                                    if(inside===undefined) inside = val['inside_'+val.system];
                                    if(inside===undefined || inside.data<-3276) {
                                        nibe.log(`Ingen inomhusgivare vald eller felaktigt värde.`,'weather','debug');
                                        //server.sendError('Prognosreglering',`Inomhusgivare saknas (${data.system}).`);
                                    }
                                    val.weatherSensor = inside;
                                    if(inside===undefined) inside = val['inside_'+val.system];
                                    if(inside!==undefined && inside.data>-3276) {
                                        nibe.log(`Sparar värde för vald inomhusgivare (${inside.data} grader)`,'weather','debug');
                                        saveDataGraph('weather_sensor_'+val.system,timeNow,inside.data,true);
                                    }

                                    nibeData.emit('pluginWeather',val);
                        } else {
                            nibe.log(`Väderleverantör svarar inte, problem med uppkopplingen eller felaktigt angivna koordinater`,'weather','error');
                            if(weatherOffset[val.system]!==0) {
                                nibe.log(`Sätter kurvjustering till 0`,'weather','debug');
                                curveAdjust('weather',val.system,0);
                                weatherOffset[val.system] = 0;
                            }
                            saveDataGraph('weather_offset_'+val.system,timeNow,0,true);
                        }
                    });
                
                }).on("error", (err) => {
                    nibe.log(err.message,'weather','error');
                });
            } else {
                nibe.log(`Inga koordinater inlagda.`,'weather','error');
                if(weatherOffset[val.system]!==0) {
                    nibe.log(`Sätter kurvjustering till 0`,'weather','debug');
                    curveAdjust('weather',val.system,0);
                    weatherOffset[val.system] = 0;
                }
                saveDataGraph('weather_offset_'+val.system,timeNow,0,true);
            }
        } else {
            nibe.log(`Prognosreglering inte aktiverat`,'weather','debug');
            if(weatherOffset[val.system]!==0) {
                nibe.log(`Sätter kurvjustering till 0`,'weather','debug');
                curveAdjust('weather',val.system,0);
                weatherOffset[val.system] = 0;
            }
            saveDataGraph('weather_offset_'+val.system,timeNow,0,true);
        }
        
    }
    const indoorArray = [];
    const runIndoor = (data,array) => {
        var timeNow = Date.now();
        //let data = Object.assign({}, result);
        let conf = nibe.getConfig();
        let inside_enable = data['inside_enable_'+data.system];
        let inside;
        if(conf.indoor===undefined) {
            conf.indoor = {};
            nibe.setConfig(conf);
        }
        if((inside_enable!==undefined && inside_enable.data!==undefined && inside_enable.data===1) || (conf.indoor['enable_'+data.system]!==undefined && conf.indoor['enable_'+data.system]===true)) {
            if(conf.indoor['enable_'+data.system]!==undefined && conf.indoor['enable_'+data.system]===true) {
                if(conf.indoor['sensor_'+data.system]!==undefined && conf.indoor['sensor_'+data.system]!=="") {
                let index = array.findIndex(i => i.name == conf.indoor['sensor_'+data.system]);
                if(index!==-1) {
                    inside = array[index];
                }
            }
            }
        if(inside===undefined) inside = data['inside_'+data.system];
        if(inside===undefined || inside.data===undefined || inside.data<4) {
            sendError('Inomhusreglering',`Inomhusgivare saknas (${data.system}), avbryter...`);
            return;
        }
        data.indoorSensor = inside;
        saveDataGraph('indoor_sensor_'+data.system,timeNow,inside.data,true)
        let inside_set = data['inside_set_'+data.system];
        let factor = data['inside_factor_'+data.system];
        let dM = data.dM;
        let dMstart = data.dMstart;
        // Calculate setpoint accuracy
        if(inside!==undefined) {
            indoorArray.unshift({set:inside_set.data,act:inside.data});
            if(indoorArray.length>=2016) indoorArray.pop();
            let sum = 0;
            for (const arr of indoorArray) {
                sum = sum+(arr.act/arr.set)
            }
            let result = sum/(indoorArray.length);
            data.accuracy = result;
        }
        // Restore degree minutes if the inside conditions are good.
        if(conf.system.pump!=="F370" && conf.system.pump!=="F470") {
            if(conf.indoor.dm_reset_enable===true) {
                if(conf.indoor.dm_reset_value===undefined) {
                    conf.indoor.dm_reset_value = -200;
                    nibe.setConfig(conf);
                }
                if((conf.indoor.dm_reset_enable_stop!==undefined && conf.indoor.dm_reset_enable_stop===true) && inside.data-conf.indoor.dm_reset_stop_diff > inside_set.data) {
                    if((dM.data<(dMstart.data+conf.indoor.dm_reset_value) || (dM.data > dMstart.data && dM.data < 50))) {
                        nibe.setData(dM.register,100);
                    }
                } else if((inside.data-conf.indoor.dm_reset_slow_diff > inside_set.data)) {
                    if(dM.data<(dMstart.data+conf.indoor.dm_reset_value)) {
                        nibe.setData(dM.register,dMstart.data);
                    }
                }
            }
        } else {
            // Non compatible heatpump
            if(conf.indoor.dm_reset_enable===true) {
                conf.indoor.dm_reset_enable = false;
                nibe.setConfig(conf);
            }
            if(conf.indoor.dm_reset_enable_stop===true) {
                conf.indoor.dm_reset_enable_stop = false;
                nibe.setConfig(conf);
            }
        }
            if(conf.indoor['enable_'+data.system]!==undefined && conf.indoor['enable_'+data.system]===true) {
                var setOffset = Number((((inside_set.data)-inside.data)*factor.data).toFixed(2));
                data.indoorOffset = setOffset;
                indoorOffset[data.system] = setOffset;
                curveAdjust('indoor',data.system,setOffset);
            } else {
                if(indoorOffset[data.system]!==0) {
                    indoorOffset[data.system] = 0;
                    curveAdjust('indoor',data.system,0);
                }
                data.indoorOffset = 0;
            }
            saveDataGraph('indoor_offset_'+data.system,timeNow,setOffset,true)
            nibeData.emit('pluginIndoor',data);
        } else {
            if(indoorOffset[data.system]!==0) {
                indoorOffset[data.system] = 0;
                curveAdjust('indoor',data.system,0);
            }
            data.indoorOffset = 0;
            saveDataGraph('indoor_offset_'+data.system,timeNow,setOffset,true)
        }
    }
    const priceAdjustCurve = async (dataIn) => {
        var data = Object.assign({}, dataIn);
        let system = data.system;
        let inside = data.priceSensor;
        nibe.log(`Startar elprisjustering priceAdjustCurve() för ${data.system}`,'price','debug');
        let config = nibe.getConfig();
        
        if(config.price===undefined) {
            config.price = {};
            nibe.setConfig(config);
        }
        if(config.price['temp_low_'+system]===undefined) {
            config.price['temp_low_'+system] = 0;
            nibe.setConfig(config);
        }
        if(data.price_level===undefined) {
            var hw_level = data.hw_price_level.data
            var heat_level = data.heat_price_level.data
            let hw_enable = config.price.hotwater_enable;
            let heat_enable = config.price['enable_heat_'+system];
            // Justera VV
             if(hw_level!==undefined && hw_level!==0) {
                var hw_adjust;
                nibe.log(`Varmvatten: ${hw_enable}`,'price','debug');
                if(hw_level=="VERY_CHEAP") {
                    nibe.log(`Nivån är väldigt billig`,'price','debug');
                    if(hw_enable!==undefined && hw_enable===true) {
                        hw_adjust = Number(config.price.hotwater_very_cheap);
                    }
           
                    
                } else if(hw_level=="CHEAP") {
                    nibe.log(`Nivån är billig`,'price','debug');
                    if(hw_enable!==undefined && hw_enable===true) {
                        hw_adjust = Number(config.price.hotwater_cheap);
                    }
                    
                } else if(hw_level=="NORMAL") {
                    nibe.log(`Nivån är normal`,'price','debug');
                    if(hw_enable!==undefined && hw_enable===true) {
                        hw_adjust = Number(config.price.hotwater_normal);
                    }
                } else if(hw_level=="EXPENSIVE") {
                    nibe.log(`Nivån är dyr`,'price','debug');
                    if(hw_enable!==undefined && hw_enable===true) {
                        hw_adjust = Number(config.price.hotwater_expensive);
                    }
                } else if(hw_level=="VERY_EXPENSIVE") {
                    nibe.log(`Nivån är väldigt dyr`,'price','debug');
                    if(hw_enable!==undefined && hw_enable===true) {
                        hw_adjust = Number(config.price.hotwater_very_expensive);
                    }

                }
                if(hw_adjust!==undefined) {
                    nibe.reqData(hP.hw_mode).then(result => {
                        if(result.raw_data!==hw_adjust) nibe.setData(hP.hw_mode,hw_adjust);
                    }).catch(console.log)
                }
            } else {
                sendError('Elprisreglering',`Kunde ej hämta prisnivå från värmepumpen eller funktion avstängd.`);
                
                
            }
            // Justera värme
            if(heat_level!==undefined && heat_level!==0) {
                let temp_diff = config.price['temp_low_'+system];
                let heat_adjust = 0;
                
                nibe.log(`Värme: ${heat_enable}`,'price','debug');
                if(data['inside_set_'+system]!==undefined) {
                    nibe.log(`Lägsta inomhustemperatur: ${data['inside_set_'+system].data+temp_diff} grader`,'price','debug');
                }
                if(heat_level=="VERY_CHEAP") {
                    nibe.log(`Nivån är väldigt billig`,'price','debug');
    
                    if(heat_enable!==undefined && heat_enable===true) if(config.price['heat_very_cheap_'+system]!==undefined) heat_adjust = config.price['heat_very_cheap_'+system];
                } else if(heat_level=="CHEAP") {
                    nibe.log(`Nivån är billig`,'price','debug');
                    if(heat_enable!==undefined && heat_enable===true) if(config.price['heat_cheap_'+system]!==undefined) heat_adjust = config.price['heat_cheap_'+system];
                } else if(heat_level=="NORMAL") {
                    nibe.log(`Nivån är normal`,'price','debug');
                    if(config.price['heat_normal_'+system]!==undefined) heat_adjust = config.price['heat_normal_'+system];
                } else if(heat_level=="EXPENSIVE") {
                    nibe.log(`Nivån är dyr`,'price','debug');
                    if(inside!==undefined && (inside.data>(data['inside_set_'+system].data+temp_diff)) || config.price['enable_temp_'+system]===undefined || config.price['enable_temp_'+system]===false) {
                    if(heat_enable!==undefined && heat_enable===true) {
                        if(config.price['heat_expensive_'+system]!==undefined) {
                            heat_adjust = config.price['heat_expensive_'+system];
                            nibe.log(`Justerar värmen ${heat_adjust}`,'price','debug');
                        }
                    }
                    }
                } else if(heat_level=="VERY_EXPENSIVE") {
                    nibe.log(`Nivån är väldigt dyr`,'price','debug');
                    if(heat_enable!==undefined && heat_enable===true) {
                        if(inside!==undefined && (inside.data>(data['inside_set_'+system].data+temp_diff)) || config.price['enable_temp_'+system]===undefined || config.price['enable_temp_'+system]===false) {
                            if(config.price['heat_very_expensive_'+system]!==undefined) heat_adjust = config.price['heat_very_expensive_'+system];
                        }
                    }
                }
                if(config.price.enable_freq===true) {
                    await lockFreq({heat:heat_adjust}).then(result => {
                        if(result!==null) nibe.log(`Frekvensen sänkt till ${result} hz`,'price','debug');
                        if(result===null) nibe.log(`Frekvensen ej längre sänkt`,'price','debug');
                    }).catch(async err => {
                        nibe.log(err,'price','debug');
                        blockAdditive({heat:heat_adjust}).then(result => {
                        }).catch(async err => {
                            nibe.log(`Värmepump stödjer inte stopp via gradminuter`,'price','debug');
                        })
                    })
                } else if(config.price.enable_dM_reset) {
                    blockAdditive({heat:heat_adjust}).then(result => {
                    }).catch(async err => {
                        nibe.log(`Värmepump stödjer inte stopp via gradminuter`,'price','debug');
                    })
                }
                
                priceOffset[system] = heat_adjust;
                curveAdjust('price',system,heat_adjust);
            } else {
                sendError('Elprisreglering',`Kunde ej hämta prisnivå från värmepumpen eller funktion avstängd.`);
                if(priceOffset[system]!==0) {
                    priceOffset[system] = 0;
                    curveAdjust('price',system,0);
                }
                
            }
        } else {
            let level = data.price_level.data;
            if(level!==undefined && level!==0) {
                let hw_enable = config.price.hotwater_enable;
                let heat_enable = config.price['enable_heat_'+system];
                let temp_diff = config.price['temp_low_'+system];
                let hw_adjust;
                let heat_adjust = 0;
                
                nibe.log(`Varmvatten: ${hw_enable}, Värme: ${heat_enable}`,'price','debug');
                if(data['inside_set_'+system]!==undefined) {
                    nibe.log(`Lägsta inomhustemperatur: ${data['inside_set_'+system].data+temp_diff} grader`,'price','debug');
                }
                if(level=="VERY_CHEAP") {
                    nibe.log(`Nivån är väldigt billig`,'price','debug');
    
                    if(hw_enable!==undefined && hw_enable===true) hw_adjust = Number(config.price.hotwater_very_cheap);
                    if(heat_enable!==undefined && heat_enable===true) {
                        if(config.price['heat_very_cheap_'+system]!==undefined) heat_adjust = config.price['heat_very_cheap_'+system];
                        if(config.system.pump!=="F370" && config.system.pump!=="F470") {
                            if(heat_adjust!==0) {
                                if(data.dM===undefined) {
                                    data.dM = await getNibeData(hP['dM']).catch(console.log)
                                }
                                if(data.dM.data > 0 && data.dM.data > data.dMstart.data+25) {
                                    nibe.log(`Ställer in gradminuter nära start ${data.dMstart.data+25}`,'price','debug');
                                    nibe.setData(hP['dM'],(data.dMstart.data+25));
                                }
                                
                            }
                        }
                    }
                } else if(level=="CHEAP") {
                    nibe.log(`Nivån är billig`,'price','debug');
                    if(hw_enable!==undefined && hw_enable===true) hw_adjust = Number(config.price.hotwater_cheap);
                    if(heat_enable!==undefined && heat_enable===true) {
                        if(config.price['heat_cheap_'+system]!==undefined) heat_adjust = config.price['heat_cheap_'+system];
                        if(config.system.pump!=="F370" && config.system.pump!=="F470") {
                            if(heat_adjust!==0) {
                                if(data.dM===undefined) {
                                    data.dM = await getNibeData(hP['dM']).catch(console.log);
                                }
                                if(data.dM.data > 0 && data.dM.data > data.dMstart.data+25) {
                                    nibe.log(`Ställer in gradminuter nära start ${data.dMstart.data+25}`,'price','debug');
                                    nibe.setData(hP['dM'],(data.dMstart.data+25));
                                }
                            }
                        }
                    }
                } else if(level=="NORMAL") {
                    nibe.log(`Nivån är normal`,'price','debug');
                    if(hw_enable!==undefined && hw_enable===true) hw_adjust = Number(config.price.hotwater_normal);
                    if(config.price['heat_normal_'+system]!==undefined) heat_adjust = config.price['heat_normal_'+system];
                } else if(level=="EXPENSIVE") {
                    
                    nibe.log(`Nivån är dyr`,'price','debug');
                    if(hw_enable!==undefined && hw_enable===true) hw_adjust = Number(config.price.hotwater_expensive);
                    if(inside!==undefined && (inside.data>(data['inside_set_'+system].data+temp_diff)) || config.price['enable_temp_'+system]===undefined || config.price['enable_temp_'+system]===false) {
                    if(heat_enable!==undefined && heat_enable===true) {
                        if(config.price['heat_expensive_'+system]!==undefined) {
                            heat_adjust = config.price['heat_expensive_'+system];
                            nibe.log(`Justerar värmen ${heat_adjust}`,'price','debug');
                        }
                    }
                    }
                } else if(level=="VERY_EXPENSIVE") {
                    nibe.log(`Nivån är väldigt dyr`,'price','debug');
                    if(hw_enable!==undefined && hw_enable===true) hw_adjust = Number(config.price.hotwater_very_expensive);
                    if(heat_enable!==undefined && heat_enable===true) {
                        if(inside!==undefined && (inside.data>(data['inside_set_'+system].data+temp_diff)) || config.price['enable_temp_'+system]===undefined || config.price['enable_temp_'+system]===false) {
                            if(config.price['heat_very_expensive_'+system]!==undefined) heat_adjust = config.price['heat_very_expensive_'+system];
                        }
                    }
                }
                if(config.price.enable_freq===true) {
                    await lockFreq({heat:heat_adjust}).then(result => {
                        if(result!==null) nibe.log(`Frekvensen sänkt till ${result} hz`,'price','debug');
                        if(result===null) nibe.log(`Frekvensen ej längre sänkt`,'price','debug');
                    }).catch(async err => {
                        nibe.log(err,'price','debug');
                        blockAdditive({heat:heat_adjust}).then(result => {
                        
                        }).catch(async err => {
                            nibe.log(`Värmepump stödjer inte stopp via gradminuter`,'price','debug');
                        })
                    })
                } else if(config.price.enable_dM_reset) {
                    blockAdditive({heat:heat_adjust}).then(result => {
                    }).catch(async err => {
                        nibe.log(`Värmepump stödjer inte stopp via gradminuter`,'price','debug');
                    })
                }
                priceOffset[system] = heat_adjust;
                curveAdjust('price',system,heat_adjust);
                if(hw_adjust!==undefined) {
                    nibe.reqData(hP.hw_mode).then(result => {
                        if(result.raw_data!==hw_adjust) nibe.setData(hP.hw_mode,hw_adjust);
                    }).catch(console.log)
                }
            } else {
                sendError('Elprisreglering',`Kunde ej hämta prisnivå från värmepumpen.`);
                if(priceOffset[system]!==0) {
                    priceOffset[system] = 0;
                    await lockFreq({heat:0}).then(result => {
                        if(result!==null) nibe.log(`Frekvensen sänkt till ${result} hz`,'price','debug');
                        if(result===null) nibe.log(`Frekvensen ej längre sänkt`,'price','debug');
                    }).catch(async err => {
                        nibe.log(err,'price','debug');
                        blockAdditive({heat:0}).then(result => {
                        
                        }).catch(async err => {
                            nibe.log(`Värmepump stödjer inte stopp via gradminuter`,'price','debug');
                        })
                    })
                    curveAdjust('price',system,0);
                }
                
            }
        }
        
    }
    let nibeGraph = [];
    let nibeGraphAdjust = [];
    function nibeBuildGraph(data,system) {
        if(data.price_level.raw_data!==0) {
            if(nibeGraph.length>600) nibeGraph.shift();
            if(nibeGraphAdjust.length>600) nibeGraphAdjust.shift();
            let config = nibe.getConfig();
            if(config.price===undefined) {
                config.price = {};
                nibe.setConfig(config);
            }
            let heat_enable = config.price['enable_heat_'+system];
            var heat_adjust = 0;
            if(data.price_level.data=="CHEAP") {
                if(heat_enable!==undefined && heat_enable===true) if(config.price['heat_cheap_'+system]!==undefined) heat_adjust = config.price['heat_cheap_'+system];
            } else if(data.price_level.data=="NORMAL") {
                if(heat_enable!==undefined && heat_enable===true) if(config.price['heat_normal_'+system]!==undefined) heat_adjust = config.price['heat_normal_'+system];
            } else if(data.price_level.data=="EXPENSIVE") {
                if(heat_enable!==undefined && heat_enable===true) if(config.price['heat_expensive_'+system]!==undefined) heat_adjust = config.price['heat_expensive_'+system];
            }
            nibeGraph.push({x:data.price_current.timestamp,y:Number(data.price_current.data)});
            nibeGraphAdjust.push({x:data.price_current.timestamp,y:Number(heat_adjust)})
            nibeGraph.sort((a, b) => (a.x > b.x) ? 1 : -1)
            nibeGraphAdjust.sort((a, b) => (a.x > b.x) ? 1 : -1)
            var sendArray = [
                {
                    "series":["Pris","Kurvjustering"],
                    "data":[nibeGraph,nibeGraphAdjust],
                    "labels":["Pris","Kurvjustering"]
                }];
            let result = {values:sendArray,system:system};
            return result;
        } else {
            let result = {values:[],system:system};
            return result;
        }
        
    }
    function priceBuildPoolGraph(prices,system) {
        let config = nibe.getConfig();
        if(config.price===undefined) {
            config.price = {};
            nibe.setConfig(config);
        }
        var priceArray = prices.prices
        priceArray.sort(function(a,b){return a.value - b.value});

        var valueArray = [];
        var adjustArray = [];
        for( var o = 0; o < priceArray.length; o++){
            let timestamp = priceArray[o].ts
            var adjust = 0;
            let value = Number((priceArray[o].value/100).toFixed(2));
            if(config.price[`${priceArray[o].level}_POOL_HEAT`]!==undefined) {
                adjust = config.price[`${priceArray[o].level}_POOL_HEAT`]
            }
            valueArray.push({x:timestamp,y:Number(value)});
            adjustArray.push({x:timestamp,y:Number(adjust.toFixed(2))})
            
        }
        valueArray.sort((a, b) => (a.x > b.x) ? 1 : -1)
        adjustArray.sort((a, b) => (a.x > b.x) ? 1 : -1)

        var sendArray = [
            {
                "series":["Pris","Kurvjustering"],
                "data":[valueArray,adjustArray],
                "labels":["Pris","Kurvjustering"]
            }];
        let result = {values:sendArray,system:system};
        return result;
    }
    function priceaiBuildGraph(heat,hw,data,prio_add_enable) {
        var system = data.system
        let config = nibe.getConfig();
        if(config.price===undefined) {
            config.price = {};
            nibe.setConfig(config);
        }
        let heat_enable = config.price['enable_heat_'+system];
        var priceArrayHeat = heat.prices
        priceArrayHeat.sort(function(a,b){return a.value - b.value});
        var priceArrayHW = hw.prices
        priceArrayHW.sort(function(a,b){return a.value - b.value});

        var valueArray = [];
        var adjustArrayHeat = [];
        var adjustArrayHW = [];
        for( var o = 0; o < priceArrayHeat.length; o++){
            let timestamp = priceArrayHeat[o].ts
            var adjust = 0;
            let hotwater_adjust = Number(config.price.hotwater_normal);
            let value = Number((priceArrayHeat[o].value/100).toFixed(2));
            if(priceArrayHeat[o].level=="VERY_CHEAP") {
                hotwater_adjust = Number(config.price.hotwater_very_cheap);
                if(heat_enable!==undefined && heat_enable===true) adjust = config.price['heat_very_cheap_'+system]||0;
            } else if(priceArrayHeat[o].level=="CHEAP") {
                hotwater_adjust = Number(config.price.hotwater_cheap);
                if(heat_enable!==undefined && heat_enable===true) adjust = config.price['heat_cheap_'+system]||0;
            } else if(priceArrayHeat[o].level=="NORMAL") {
                hotwater_adjust = Number(config.price.hotwater_normal);
                if(heat_enable!==undefined && heat_enable===true) adjust = config.price['heat_normal_'+system]||0;
            } else if(priceArrayHeat[o].level=="EXPENSIVE") {
                hotwater_adjust = Number(config.price.hotwater_expensive);
                if(heat_enable!==undefined && heat_enable===true) adjust = config.price['heat_expensive_'+system]||0;
            } else if(priceArrayHeat[o].level=="VERY_EXPENSIVE") {
                hotwater_adjust = Number(config.price.hotwater_very_expensive);
                if(heat_enable!==undefined && heat_enable===true) adjust = config.price['heat_very_expensive_'+system]||0;
            }
            valueArray.push({x:timestamp,y:Number(value)});
            adjustArrayHeat.push({x:timestamp,y:Number(adjust.toFixed(2))})
            
        }
        for( var o = 0; o < priceArrayHW.length; o++){
            let timestamp = priceArrayHW[o].ts
            let hotwater_adjust = Number(config.price.hotwater_normal);
            if(priceArrayHW[o].level=="VERY_CHEAP") {
                hotwater_adjust = Number(config.price.hotwater_very_cheap);
            } else if(priceArrayHW[o].level=="CHEAP") {
                hotwater_adjust = Number(config.price.hotwater_cheap);
            } else if(priceArrayHW[o].level=="NORMAL") {
                hotwater_adjust = Number(config.price.hotwater_normal);
            } else if(priceArrayHW[o].level=="EXPENSIVE") {
                hotwater_adjust = Number(config.price.hotwater_expensive);
            } else if(priceArrayHW[o].level=="VERY_EXPENSIVE") {
                hotwater_adjust = Number(config.price.hotwater_very_expensive);
            }
            adjustArrayHW.push({x:timestamp,y:Number(hotwater_adjust.toFixed(2))})
            
        }
        valueArray.sort((a, b) => (a.x > b.x) ? 1 : -1)
        adjustArrayHeat.sort((a, b) => (a.x > b.x) ? 1 : -1)
        adjustArrayHW.sort((a, b) => (a.x > b.x) ? 1 : -1)

        var sendArray = [
            {
                "series":["Pris","Värmejustering","Varmvattenläge"],
                "data":[valueArray,adjustArrayHeat,adjustArrayHW],
                "labels":["Pris","Värmejustering","Varmvattenläge"]
            }];
            if(prio_add_enable!==undefined) {
                if(config.price.prio_enable===true) {
                    nibe.log(`Prioriterad tillsats är aktiverad som elprisreglering, skapar graf`,'price','debug');
                    var prioArray = [];
                    let fee = config.price.prio_tax+config.price.prio_transfer
                    let cop = config.price.prio_cop
                    let cost = config.price.prio_cost
                    for( var o = 0; o < priceArrayHeat.length; o++){
                        let timestamp = priceArrayHeat[o].ts
                        var adjust = 0;
                        let price = Number((priceArrayHeat[o].value).toFixed(2));
                        if(price+fee > cost*cop) {
                            // Reglering
                            prioArray.push({x:timestamp,y:10})
                        } else {
                            // Ingen reglering
                            prioArray.push({x:timestamp,y:0})

                        }
                    }
                    prioArray.sort((a, b) => (a.x > b.x) ? 1 : -1)
                    sendArray[0].series.push('Prio. tillsats')
                    sendArray[0].data.push(prioArray)
                    sendArray[0].labels.push('Prio. tillsats')
                }
            }
        let result = {values:sendArray,system:system};
        return result;
    }
    function tibberBuildGraph(tibber,system) {
        let config = nibe.getConfig();
        if(config.price===undefined) {
            config.price = {};
            nibe.setConfig(config);
        }
        if(config.price.tibber_home===undefined) {
            config.price.tibber_home = 0
            nibe.setConfig(config);
        }
        let heat_enable = config.price['enable_heat_'+system];
        var today = tibber.data.viewer.homes[config.price.tibber_home].currentSubscription.priceInfo.today;
        var tomorrow;
        if(tibber.data.viewer.homes[config.price.tibber_home].currentSubscription.priceInfo.tomorrow!==undefined) {
            tomorrow = tibber.data.viewer.homes[config.price.tibber_home].currentSubscription.priceInfo.tomorrow;
        }
        var priceArray = today.concat(tomorrow);
        priceArray.sort(function(a,b){return a.energy - b.energy});
        if(tibber.data.viewer.homes[config.price.tibber_home].currentSubscription.priceInfo.tomorrow!==undefined) {
            tomorrow = tibber.data.viewer.homes[config.price.tibber_home].currentSubscription.priceInfo.tomorrow;
        }
        var valueArray = [];
        var adjustArray = [];
        for( var o = 0; o < priceArray.length; o++){
            let timestamp = toTimestamp(priceArray[o].startsAt)
            var adjust = 0;
            let hotwater_adjust = Number(config.price.hotwater_normal);
            let value = Number(priceArray[o].energy.toFixed(2));
            if(priceArray[o].level=="VERY_CHEAP") {
                hotwater_adjust = Number(config.price.hotwater_very_cheap);
                if(heat_enable!==undefined && heat_enable===true) adjust = config.price['heat_very_cheap_'+system]||0;
            } else if(priceArray[o].level=="CHEAP") {
                hotwater_adjust = Number(config.price.hotwater_cheap);
                if(heat_enable!==undefined && heat_enable===true) adjust = config.price['heat_cheap_'+system]||0;
            } else if(priceArray[o].level=="NORMAL") {
                hotwater_adjust = Number(config.price.hotwater_normal);
                if(heat_enable!==undefined && heat_enable===true) adjust = config.price['heat_normal_'+system]||0;
            } else if(priceArray[o].level=="EXPENSIVE") {
                hotwater_adjust = Number(config.price.hotwater_expensive);
                if(heat_enable!==undefined && heat_enable===true) adjust = config.price['heat_expensive_'+system]||0;
            } else if(priceArray[o].level=="VERY_EXPENSIVE") {
                hotwater_adjust = Number(config.price.hotwater_very_expensive);
                if(heat_enable!==undefined && heat_enable===true) adjust = config.price['heat_very_expensive_'+system]||0;
            }
            valueArray.push({x:timestamp,y:Number(value)});
            adjustArray.push({x:timestamp,y:Number(adjust.toFixed(2))})
            
        }
        valueArray.sort((a, b) => (a.x > b.x) ? 1 : -1)
        adjustArray.sort((a, b) => (a.x > b.x) ? 1 : -1)

        var sendArray = [
            {
                "series":["Pris","Kurvjustering"],
                "data":[valueArray,adjustArray],
                "labels":["Pris","Kurvjustering"]
            }];
        let result = {values:sendArray,system:system};
        return result;
    }
    async function runPriceOld(data,array) {
        
        nibe.log(`Startar elprisreglering runPrice()`,'price','debug');
        //let data = Object.assign({}, result);
        let config = nibe.getConfig();
        let inside;
        nibe.log(`Letar efter givare ${config.price['sensor_'+data.system]}`,'price','debug');
        if(config.price['sensor_'+data.system]!==undefined && config.price['sensor_'+data.system]!=="") {
            let index = array.findIndex(i => i.name == config.price['sensor_'+data.system]);
            if(index!==-1) {
                inside = array[index];
                nibe.log(`Sätter inomhusgivare ${config.price['sensor_'+data.system]}, ${inside.data} grader`,'price','debug');
            }
        }
        data.priceSensor = inside;
        if(config.price!==undefined && config.price.enable===true) {
            nibe.log(`Elprisreglering är aktiverad`,'price','debug');
            if(config.price.source=="tibber") {
                nibe.log(`Källan är Tibber`,'price','debug');
                
                if(config.price.token!==undefined && config.price.token!=="") {
                    let token = config.price.token;
                    const options = {
                        hostname: 'api.tibber.com',
                        port: 443,
                        path: '/v1-beta/gql',
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json'
                        }
                      };
                      const request = JSON.stringify({
                        query: "{\
                            viewer {\
                                homes {\
                                currentSubscription {\
                                    status\
                                    priceInfo {\
                                    today{\
                                        startsAt\
                                        total\
                                        energy\
                                        level\
                                        tax\
                                    }\
                                    current{\
                                        total\
                                        energy\
                                        level\
                                        tax\
                                        startsAt\
                                    }\
                                    tomorrow {\
                                        startsAt\
                                        total\
                                        level\
                                        energy\
                                        tax\
                                    }\
                                    }\
                                }\
                                consumption(resolution: HOURLY, last: 48) {\
                                    nodes {\
                                    from\
                                    to\
                                    consumption\
                                    consumptionUnit\
                                    }\
                                }\
                                }\
                            }\
                            }"
                        });
                    await getCloudData(options,request).then(result => {
                        data.tibber = result;
                        data.price_current = {};
                        data.price_current.data = Number((result.data.viewer.homes[config.price.tibber_home].currentSubscription.priceInfo.current.energy*100).toFixed(2))
                        data.price_current.raw_data = Number((result.data.viewer.homes[config.price.tibber_home].currentSubscription.priceInfo.current.energy*100).toFixed(2))
                        data.price_level = {};
                        data.price_level.data = result.data.viewer.homes[config.price.tibber_home].currentSubscription.priceInfo.current.level;
                        data.price_level.raw_data = result.data.viewer.homes[config.price.tibber_home].currentSubscription.priceInfo.current.level;
                        priceAdjustCurve(data)
                        nibeData.emit('pluginPrice',data);
                        nibeData.emit('pluginPriceGraph',tibberBuildGraph(result,data.system));
                    },(reject => {
                        console.log(reject)
                    }));
                } else {
                    sendError('Cloud',`Token är inte giltigt.`);
                    return
                }
                
            } else if(config.price.source=="nibe") {
                nibe.log(`Källan är Nibe`,'price','debug');
                data.price_level = await getNibeData(hP['price_level']).catch(console.log);
                data.price_enable = await getNibeData(hP['price_enable']).catch(console.log);
                priceAdjustCurve(data)
                data.price_current = await getNibeData(hP['price_current']).catch(console.log);
                nibeData.emit('pluginPriceGraph',nibeBuildGraph(data,data.system));
                nibeData.emit('pluginPrice',data);
            } else if (config.price.source == "priceai") {
                nibe.log(`Source is Home Assistant (Nord Pool) via HA entity ${HA_ENTITY}`, "price", "debug");

                try {
                    // 1) Fetch HA state once
                    const haState = await fetchHAEntity(HA_ENTITY);
                    const attrs   = haState && haState.attributes ? haState.attributes : {};

                    // 2) Join raw_today + raw_tomorrow (raw_tomorrow can be [])
                    const joined = []
                        .concat(Array.isArray(attrs.raw_today)    ? attrs.raw_today    : [])
                        .concat(Array.isArray(attrs.raw_tomorrow) ? attrs.raw_tomorrow : [])
                        .filter(p => p && p.start && typeof p.value === "number");

                    nibe.log(
                        `HA Nord Pool: today=${Array.isArray(attrs.raw_today) ? attrs.raw_today.length : 0}, ` +
                        `tomorrow=${Array.isArray(attrs.raw_tomorrow) ? attrs.raw_tomorrow.length : 0}, ` +
                        `joined=${joined.length}`,
                        "price", "debug"
                    );

                    if (joined.length === 0) {
                        nibe.log("No price data available from HA (joined list is empty).", "price", "warn");
                        return;
                    }

                    // 3) Map to Tibber-like structure the rest of the code expects
                    let fullPriceList = joined.map(p => ({ startsAt: p.start, total: p.value }));

                    // 4) Sort and log window
                    fullPriceList.sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
                    const first = fullPriceList[0];
                    const last  = fullPriceList[fullPriceList.length - 1];
                    nibe.log(`Price window: ${first.startsAt} → ${last.startsAt}`, "price", "debug");

                    // 5) Determine current/next hour
                    const now = new Date();
                    now.setMinutes(0, 0, 0);
                    const futurePriceList = fullPriceList.filter(p => new Date(p.startsAt) >= now);
                    if (futurePriceList.length === 0) {
                        nibe.log("No future price data available from HA.", "price", "warn");
                        return;
                    }

                    nibe.log(`Future price points: ${futurePriceList.length}`, "price", "debug")

                    const currentHour      = futurePriceList[0];
                    const currentHourDate  = currentHour.startsAt;
                    

                    // 6) Feed optimization (expects cents/öre scale)
                    const priceDataForAlgo = fullPriceList.map(p => ({
                        value: p.total * PRICE_TO_CENTS_MULTIPLIER,
                        ts:    new Date(p.startsAt).getTime(),
                        date:  p.startsAt
                    }));

                    const algoOptions  = {
                        timeWindow: config.price.time,
                        minSpread:  config.price.min_spread
                    };
                    const optimalTrades = optimizeElectricityTrading(priceDataForAlgo, algoOptions);

                    // 7) Classify CHEAP/EXPENSIVE buckets
                    let currentLevel = "NORMAL";
                    let veryCheapHours, cheapHours, expensiveHours, veryExpensiveHours;

                    if (optimalTrades.buy.length > 0) {
                        const buyPrices  = optimalTrades.buy.sort((a, b) => a.value - b.value);
                        const sellPrices = optimalTrades.sell.sort((a, b) => a.value - b.value);
                        const buyMedianIndex  = Math.floor(buyPrices.length  / 2);
                        const sellMedianIndex = Math.floor(sellPrices.length / 2);

                        veryCheapHours     = new Set(buyPrices.slice(0, buyMedianIndex).map(p => p.date));
                        cheapHours         = new Set(buyPrices.slice(buyMedianIndex).map(p => p.date));
                        expensiveHours     = new Set(sellPrices.slice(0, sellMedianIndex).map(p => p.date));
                        veryExpensiveHours = new Set(sellPrices.slice(sellMedianIndex).map(p => p.date));

                        if (veryCheapHours.has(currentHourDate))           currentLevel = "VERY_CHEAP";
                        else if (cheapHours.has(currentHourDate))          currentLevel = "CHEAP";
                        else if (veryExpensiveHours.has(currentHourDate))  currentLevel = "VERY_EXPENSIVE";
                        else if (expensiveHours.has(currentHourDate))      currentLevel = "EXPENSIVE";
                    }

                    // 8) Compose heat/hw payloads
                    const heat = {
                        level:   currentLevel,
                        current: currentHour.total * PRICE_TO_CENTS_MULTIPLIER,
                        prices:  fullPriceList.map(p => {
                            const date = p.startsAt;
                            let hourLevel = "NORMAL";
                            if (veryCheapHours && veryCheapHours.has(date))              hourLevel = "VERY_CHEAP";
                            else if (cheapHours && cheapHours.has(date))                 hourLevel = "CHEAP";
                            else if (veryExpensiveHours && veryExpensiveHours.has(date)) hourLevel = "VERY_EXPENSIVE";
                            else if (expensiveHours && expensiveHours.has(date))         hourLevel = "EXPENSIVE";

                            return {
                                value: p.total * PRICE_TO_CENTS_MULTIPLIER,
                                level: hourLevel,
                                ts:    new Date(p.startsAt).getTime()
                            };
                        })
                    };

                    const hw = { ...heat };

                    // 9) Populate data + log summary
                    data.priceai = { heat, hw };
                    data.price_current = {
                        data:      Number((heat.current).toFixed(2)),
                        raw_data:  Number((heat.current).toFixed(2)),
                        info:      "Current electrical price",
                        titel:     "Electric price",
                        register:  "electric_price",
                        unit:      "cents", // or "öre" if your multiplier is for SEK
                        icon_name: "fa-flash"
                    };
                    data.heat_price_level = { data: heat.level, raw_data: heat.level };
                    data.hw_price_level   = { data: hw.level,   raw_data: hw.level   };

                    nibe.log(
                        `HA/Nord Pool analysis complete. Level: ${heat.level}, ` +
                        `Price: ${data.price_current.data} (multiplier=${PRICE_TO_CENTS_MULTIPLIER})`,
                        "price", "debug"
                    );

                    // 10) Keep the rest identical to old flow
                    let prio_add_enable = await getNibeData(hP['prio_add_enable']).catch(() => {});
                    if (prio_add_enable === undefined || prio_add_enable.raw_data === 0) {
                        priceAdjustCurve(data);
                        adjustPool(data, data.system)
                            .then(pool => {
                                if (pool !== undefined) {
                                    nibeData.emit('pluginPriceGraphPool', priceBuildPoolGraph(heat, data.system));
                                }
                            })
                            .catch(console.log);
                    }

                    nibeData.emit('pluginPrice', data);
                    nibeData.emit('pluginPriceGraph', priceaiBuildGraph(heat, hw, data, prio_add_enable));

                } catch (err) {
                    nibe.log(`Error fetching/analysing from HA: ${err}`, "price", "error");
                    console.log(err);
                }
            }
        }
        
    }
    
    ///////##########################################################
    // ##################################################################
    // # START: Algoritm från energy.anerdins-iot.se (ORIGINAL-LOGIK)   #
    // ##################################################################

    function findTradingOpportunities(sortedPrices, originalData, config) {
        const opportunities = [];

        for (const lowPoint of sortedPrices) {
            let buyIndex = -1;
            for (let j = 0; j < originalData.length; j++) {
                if (lowPoint.ts === originalData[j].ts) {
                    buyIndex = j;
                    break;
                }
            }

            if (buyIndex === -1) continue;

            const endIndex = Math.min(buyIndex + config.timeWindow, originalData.length);

            for (let sellIndex = buyIndex + 1; sellIndex < endIndex; sellIndex++) {
                const spread = originalData[sellIndex].value - lowPoint.value;

                if (spread > config.minSpread) {
                    opportunities.push({
                        buy: lowPoint,
                        sell: originalData[sellIndex],
                        spread: spread
                    });
                }
            }
        }
        const sortedOpportunities = opportunities.sort((a, b) => b.spread - a.spread);
        if (sortedOpportunities.length > 0) {
            nibe.log(`[DEBUG] Bästa funna affär: Köp för ${sortedOpportunities[0].buy.value.toFixed(2)} öre, Sälj för ${sortedOpportunities[0].sell.value.toFixed(2)} öre, Spread: ${sortedOpportunities[0].spread.toFixed(2)} öre`, 'price', 'debug');
        }
        return sortedOpportunities;
    }



    /**
     * Hittar den optimala kombinationen av handelsmöjligheter (ORIGINAL-VERSION)
     * @private
     */
    function findOptimalCombination(opportunities) {
        if (opportunities.length === 0) return [];

        const combinations = [];

        // För varje möjlighet, bygg en kombination av icke-överlappande handel
        for (let i = 0; i < opportunities.length; i++) {
            const combination = [opportunities[i]];

            for (let j = 0; j < opportunities.length; j++) {
                if (i === j) continue;

                // Kontrollerar om en affär överlappar med någon i den nuvarande kombinationen
                const hasConflict = combination.some(trade =>
                    trade.buy.ts === opportunities[j].buy.ts ||
                    trade.sell.ts === opportunities[j].sell.ts ||
                    trade.buy.ts === opportunities[j].sell.ts ||
                    trade.sell.ts === opportunities[j].buy.ts
                );

                if (!hasConflict) {
                    combination.push(opportunities[j]);
                }
            }

            const totalProfit = combination.reduce((sum, trade) => sum + trade.spread, 0);
            combinations.push({
                trades: combination,
                totalProfit: totalProfit
            });
        }

        // Returnera kombinationen med högst total profit
        combinations.sort((a, b) => b.totalProfit - a.totalProfit);
        //return combinations[0]?.trades || [];
        // KORRIGERING: Ersätter "combinations[0]?.trades" med en säkrare variant.
        return combinations.length > 0 ? combinations[0].trades : [];
    }


    function formatResult(optimalTrades) {
        const buyPoints = [];
        const sellPoints = [];

        for (const trade of optimalTrades) {
            buyPoints.push(trade.buy);
            sellPoints.push(trade.sell);
        }

        return {
            buy: buyPoints,
            sell: sellPoints
        };
    }


    function optimizeElectricityTrading(priceData, options = {}) {
        if (!Array.isArray(priceData) || priceData.length === 0) {
            return { buy: [], sell: [] };
        }

        const config = {
            timeWindow: Number(options.timeWindow) || 12,
            // KORRIGERAD: Använder 20 (ören) som standard, enligt originalet.
            minSpread: Number(options.minSpread) || 20
        };

        const sortedByPrice = [...priceData].sort((a, b) => a.value - b.value);
        const totalSpread = sortedByPrice[sortedByPrice.length - 1].value - sortedByPrice[0].value;

        if (totalSpread <= config.minSpread) {
            return { buy: [], sell: [] };
        }

        const tradingOpportunities = findTradingOpportunities(
            sortedByPrice,
            priceData,
            config
        );

        if (tradingOpportunities.length === 0) {
            return { buy: [], sell: [] };
        }

        const optimalCombination = findOptimalCombination(tradingOpportunities);
        return formatResult(optimalCombination);
    }

    // ##################################################################
    // # SLUT: Algoritm                                                 #
    // ##################################################################



    async function runPrice(data,array) {

        nibe.log(`Startar elprisreglering runPrice()`,'price','debug');
        let config = nibe.getConfig();
        let inside;
        nibe.log(`Letar efter givare ${config.price['sensor_'+data.system]}`,'price','debug');
        if(config.price['sensor_'+data.system]!==undefined && config.price['sensor_'+data.system]!=="") {
            let index = array.findIndex(i => i.name == config.price['sensor_'+data.system]);
            if(index!==-1) {
                inside = array[index];
                nibe.log(`Sätter inomhusgivare ${config.price['sensor_'+data.system]}, ${inside.data} grader`,'price','debug');
            }
        }
        data.priceSensor = inside;
        if(config.price!==undefined && config.price.enable===true) {
            nibe.log(`Elprisreglering är aktiverad`,'price','debug');
            if(config.price.source=="tibber") {
                nibe.log(`Källan är Tibber`,'price','debug');

                if(config.price.token!==undefined && config.price.token!=="") {
                    let token = config.price.token;
                    const options = {
                        hostname: 'api.tibber.com',
                        port: 443,
                        path: '/v1-beta/gql',
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json'
                        }
                    };
                    const request = JSON.stringify({
                        query: "{\
                            viewer {\
                                homes {\
                                currentSubscription {\
                                    status\
                                    priceInfo {\
                                    today{\
                                        startsAt\
                                        total\
                                        energy\
                                        level\
                                        tax\
                                    }\
                                    current{\
                                        total\
                                        energy\
                                        level\
                                        tax\
                                        startsAt\
                                    }\
                                    tomorrow {\
                                        startsAt\
                                        total\
                                        level\
                                        energy\
                                        tax\
                                    }\
                                    }\
                                }\
                                consumption(resolution: HOURLY, last: 48) {\
                                    nodes {\
                                    from\
                                    to\
                                    consumption\
                                    consumptionUnit\
                                    }\
                                }\
                                }\
                            }\
                            }"
                        });
                    await getCloudData(options,request).then(result => {
                        data.tibber = result;
                        data.price_current = {};
                        data.price_current.data = Number((result.data.viewer.homes[config.price.tibber_home].currentSubscription.priceInfo.current.energy*100).toFixed(2))
                        data.price_current.raw_data = Number((result.data.viewer.homes[config.price.tibber_home].currentSubscription.priceInfo.current.energy*100).toFixed(2))
                        data.price_level = {};
                        data.price_level.data = result.data.viewer.homes[config.price.tibber_home].currentSubscription.priceInfo.current.level;
                        data.price_level.raw_data = result.data.viewer.homes[config.price.tibber_home].currentSubscription.priceInfo.current.level;
                        priceAdjustCurve(data)
                        nibeData.emit('pluginPrice',data);
                        nibeData.emit('pluginPriceGraph',tibberBuildGraph(result,data.system));
                    },(reject => {
                        console.log(reject)
                    }));
                } else {
                    sendError('Cloud',`Token är inte giltigt.`);
                    return
                }

            } else if(config.price.source=="nibe") {
                nibe.log(`Källan är Nibe`,'price','debug');
                data.price_level = await getNibeData(hP['price_level']).catch(console.log);
                data.price_enable = await getNibeData(hP['price_enable']).catch(console.log);
                priceAdjustCurve(data)
                data.price_current = await getNibeData(hP['price_current']).catch(console.log);
                nibeData.emit('pluginPriceGraph',nibeBuildGraph(data,data.system));
                nibeData.emit('pluginPrice',data);
            } else if (config.price.source == "priceai") {
                nibe.log(`Källan är Home Assistant (Nord Pool) via HA-entity ${HA_ENTITY}`,'price','debug');

                try {
                    const haState = await fetchHAEntity(HA_ENTITY);

                    if (!haState || !haState.attributes || !Array.isArray(haState.attributes.raw_all)) {
                        sendError('Lokal AI', 'Kunde inte läsa attributes.raw_all från Home Assistant.');
                        return;
                    }

                    // Build Tibber-like structure from HA raw_all
                    // raw_all[i] = { start: ISO, end: ISO, value: number (EUR/kWh in your sample) }
                    const fullPriceList = haState.attributes.raw_all
                    .filter(p => p && p.start && typeof p.value === "number")
                    .map(p => ({ startsAt: p.start, total: p.value })); // total == price per kWh

                    if (fullPriceList.length === 0) {
                        nibe.log('Ingen prisdata alls tillgänglig från HA.', 'price', 'warn');
                        return;
                    }

                    // Determine current hour (same style as Tibber branch)
                    const now = new Date();
                    now.setMinutes(0, 0, 0);
                    const futurePriceList = fullPriceList.filter(p => new Date(p.startsAt) >= now);
                    if (futurePriceList.length === 0) {
                        nibe.log('Ingen framtida prisdata tillgänglig från HA.', 'price', 'warn');
                        return;
                    }
                    const currentHour = futurePriceList[0];
                    const currentHourDate = currentHour.startsAt;

                    // Feed the optimization algo (expects "cents/öre" scale). We’ll multiply once here.
                    const priceDataForAlgo = fullPriceList.map(p => ({
                        value: p.total * PRICE_TO_CENTS_MULTIPLIER, // cents (or öre if you set multiplier accordingly)
                        ts: new Date(p.startsAt).getTime(),
                        date: p.startsAt
                    }));

                    const algoOptions = {
                        timeWindow: config.price.time,
                        minSpread: config.price.min_spread
                    };
                    const optimalTrades = optimizeElectricityTrading(priceDataForAlgo, algoOptions);

                    // Classify levels from the algo (VERY_CHEAP/CHEAP/NORMAL/EXPENSIVE/VERY_EXPENSIVE)
                    let currentLevel = 'NORMAL';
                    let veryCheapHours, cheapHours, expensiveHours, veryExpensiveHours;

                    if (optimalTrades.buy.length > 0) {
                        const buyPrices  = optimalTrades.buy.sort((a, b) => a.value - b.value);
                        const sellPrices = optimalTrades.sell.sort((a, b) => a.value - b.value);
                        const buyMedianIndex  = Math.floor(buyPrices.length  / 2);
                        const sellMedianIndex = Math.floor(sellPrices.length / 2);

                        veryCheapHours     = new Set(buyPrices.slice(0, buyMedianIndex).map(p => p.date));
                        cheapHours         = new Set(buyPrices.slice(buyMedianIndex).map(p => p.date));
                        expensiveHours     = new Set(sellPrices.slice(0, sellMedianIndex).map(p => p.date));
                        veryExpensiveHours = new Set(sellPrices.slice(sellMedianIndex).map(p => p.date));

                        if (veryCheapHours.has(currentHourDate))       currentLevel = 'VERY_CHEAP';
                        else if (cheapHours.has(currentHourDate))      currentLevel = 'CHEAP';
                        else if (veryExpensiveHours.has(currentHourDate)) currentLevel = 'VERY_EXPENSIVE';
                        else if (expensiveHours.has(currentHourDate))  currentLevel = 'EXPENSIVE';
                    }

                    // Compose heat/hw like the old cloud did, so the rest of the code can stay the same
                    const heat = {
                        level: currentLevel,
                        current: currentHour.total * PRICE_TO_CENTS_MULTIPLIER,
                        prices: fullPriceList.map(p => {
                            const date = p.startsAt;
                            let hourLevel = 'NORMAL';
                            if (veryCheapHours && veryCheapHours.has(date))          hourLevel = 'VERY_CHEAP';
                            else if (cheapHours && cheapHours.has(date))             hourLevel = 'CHEAP';
                            else if (veryExpensiveHours && veryExpensiveHours.has(date)) hourLevel = 'VERY_EXPENSIVE';
                            else if (expensiveHours && expensiveHours.has(date))     hourLevel = 'EXPENSIVE';

                            return { value: p.total * PRICE_TO_CENTS_MULTIPLIER, level: hourLevel, ts: new Date(p.startsAt).getTime() };
                        })
                    };

                    const hw = { ...heat };

                    data.priceai = { heat, hw };
                    data.price_current = {
                        data: Number((heat.current).toFixed(2)),
                        raw_data: Number((heat.current).toFixed(2)),
                        info: "Current electrical price",
                        titel: "Electric price",
                        register: "electric_price",
                        unit: "cents", // or "öre" if you set the multiplier for SEK
                        icon_name: "fa-flash"
                    };
                    data.heat_price_level = { data: heat.level, raw_data: heat.level };
                    data.hw_price_level   = { data: hw.level,   raw_data: hw.level   };

                    nibe.log(`HA/Nord Pool analys klar. Nivå: ${heat.level}, Pris: ${data.price_current.data} (multiplier=${PRICE_TO_CENTS_MULTIPLIER})`, 'price', 'debug');

                    // Keep the rest identical to old flow
                    let prio_add_enable = await getNibeData(hP['prio_add_enable']).catch(() => {});
                    if (prio_add_enable === undefined || prio_add_enable.raw_data === 0) {
                        priceAdjustCurve(data);
                        adjustPool(data, data.system)
                        .then(pool => {
                            if (pool !== undefined) nibeData.emit('pluginPriceGraphPool', priceBuildPoolGraph(heat, data.system));
                        })
                        .catch(console.log);
                    }

                    nibeData.emit('pluginPrice', data);
                    nibeData.emit('pluginPriceGraph', priceaiBuildGraph(heat, hw, data, prio_add_enable));

                } catch (err) {
                    nibe.log(`Fel vid hämtning/analys från HA: ${err}`, 'price', 'error');
                    console.log(err);
                }
            }
        }
    }

    const sendError = (from,message) => {
        let data = {from:from,message:message};
        nibeData.emit('fault',data);
    };
    const adjustPool = (dataIn,system) => {
        const promise = new Promise((resolve,reject) => {
            try {
                var data = Object.assign({}, dataIn);
                let config = nibe.getConfig();
                if(config.price===undefined) {
                    config.price = {}
                    nibe.setConfig(config);
                }
                if(config.price.VERY_CHEAP_POOL_HEAT===undefined) {
                    config.price.pool_enable_s1 = false
                    config.price.VERY_CHEAP_POOL_HEAT = 0
                    config.price.CHEAP_POOL_HEAT = 0
                    config.price.NORMAL_START_POOL_HEAT = 28
                    config.price.NORMAL_STOP_POOL_HEAT = 32
                    config.price.EXPENSIVE_POOL_HEAT = 0
                    config.price.VERY_EXPENSIVE_POOL_HEAT = 0
                    config.price.VERY_CHEAP_POOL_CPR = 0
                    config.price.CHEAP_POOL_CPR = 0
                    config.price.NORMAL_START_POOL_CPR = 0
                    config.price.NORMAL_STOP_POOL_CPR = 0
                    config.price.EXPENSIVE_POOL_CPR = 0
                    config.price.VERY_EXPENSIVE_POOL_CPR = 0
                    nibe.setConfig(config);
                }
                if(config.price.pool_enable_s1===true) {
                    const poolTemp = getNibeData(hP['pool_temp_'+system]).catch(console.log)
                    const poolStart = getNibeData(hP['pool_start_temp_'+system]).catch(console.log)
                    const poolStop = getNibeData(hP['pool_stop_temp_'+system]).catch(console.log)
                    const poolCpr = getNibeData(hP['pool_cpr_'+system]).catch(console.log)
                    if(config.price.pool_max_temp===undefined || isNaN(config.price.pool_max_temp)) config.price.pool_max_temp = 100
                    Promise.all([poolTemp, poolStart, poolStop, poolCpr]).then((values) => {
                        let level = data.price_level.data;
                        if(config.price[`${level}_POOL_HEAT`]!==undefined) {
                            if(level=="NORMAL") {
                                nibe.setData(hP['pool_start_temp_'+system],config.price.NORMAL_START_POOL_HEAT)
                                nibe.setData(hP['pool_stop_temp_'+system],config.price.NORMAL_STOP_POOL_HEAT)
                            } else {
                                var adjust = config.price[`${level}_POOL_HEAT`]
                                var start = config.price.NORMAL_START_POOL_HEAT
                                var stop = config.price.NORMAL_STOP_POOL_HEAT
                                nibe.setData(hP['pool_start_temp_'+system],Math.min(start+adjust,config.price.pool_max_temp))
                                nibe.setData(hP['pool_stop_temp_'+system],Math.min(stop+adjust,config.price.pool_max_temp))
                            }
                            
                            resolve(values)
                        } else {
                            resolve()
                        }
                        
                    }).catch((err) => {
                        sendError('Elprisreglering Poolstyrning',`Kunde inte hämta data, har värmepumpen stöd för pool?`);
                    });
                }
            } catch(err) {
                reject(err)
            }
        });
        return promise;
    }
    const getCloudData = (options,request) => {
        const promise = new Promise((resolve,reject) => {
        let config = nibe.getConfig();
        if(config.price===undefined) {
            config.price = {};
            nibe.setConfig(config);
        }
        if(config.price.hw_speed===undefined) {
            config.price.hw_speed = 20;
            nibe.setConfig(config);
        }
        var ts = new Date()
        var hour = ts.getHours()
        var req = JSON.parse(request)
        if(req.name=="heat") {
                get(options,request).then(async (data) => {
                    resolve(data)
                }).catch(async (err) => {
                    reject(err)
                })
        } else if(req.name=="hw") {
                try {
                    const bt6 = getNibeData(hP['bt6']).catch(console.log);
                    const bt7 = getNibeData(hP['bt7']).catch(console.log);
                    const hwStartTemp = getNibeData(hP['hw_start_0']).catch(console.log);
                    const hwStopTemp = getNibeData(hP['hw_stop_2']).catch(console.log);
                    Promise.all([bt6, bt7, hwStartTemp, hwStopTemp]).then((values) => {
                        
                        
                        request = JSON.parse(request)
                        request.battery = {
                            capacity:values[3].data,
                            value:values[0].data,
                            zero:values[2].data,
                            effect:config.price.hw_speed,
                            hw:values[1].data
                        }
                        request = JSON.stringify(request)
                        get(options,request).then(async (data) => {
                            resolve(data)
                        }).catch(async (err) => {
                            reject(err)
                        })
                    })
                } catch(err) {
                    console.log('Was not able to get values for hw optimization from the cloud')
                    get(options,request).then(async (data) => {
                        resolve(data)
                    }).catch(async (err) => {
                        reject(err)
                    })
                }
        } else {
            get(options,request).then(async (data) => {
                resolve(data)
            }).catch(async (err) => {
                reject(err)
            })
        }
        async function get(options,request) {
            const promise = new Promise((resolve,reject) => {
                let data = "";
                const req = https.request(options, (res) => {
                
                res.on('data', (d) => {
                        data += d;
                    
                })
                res.on('end', () => {
                    if(res.statusCode===200) {
                        try {
                            data = JSON.parse(data)
                            
                            nibe.log(`Data hämtad via http`,'price','debug');
                            resolve(data)
                        } catch {
                            sendError('Elprisreglering Cloud',`Kunde inte hantera JSON data`);
                            
                            nibe.log(`Något blev fel vid JSON konvertering`,'price','debug');
                            reject('No JSON response')
                        }
                    } else {
                        sendError('Cloud',`Ej kontakt med servern`);
                        reject(res.statusMessage)
                    }
                    
                });
                })
                
                req.on('error', (error) => {
                sendError('Cloud',`Ej kontakt med servern`);
                reject(error)
                })
                
                req.write(request)
                req.end()
                });
            return promise;
        }
        
        });
        return promise;
    }
    
function scale (number, inMin, inMax, outMin, outMax) {
    return (number - inMin) * (outMax - outMin) / (inMax - inMin) + outMin;
}
const lockFreq = (options) => {
    const promise = new Promise((resolve,reject) => {
    let config = nibe.getConfig();
    if(config.price===undefined) {
        config.price = {};
        nibe.setConfig(config);
    }
    if(config.system.pump!="F370" && config.system.pump!="F470" && config.system.pump!="F1145" && config.system.pump!="F1245") {
        var min_temp = config.price.min_temp
        var max_temp = config.price.max_temp
        var min_freq = config.price.min_freq
        var max_freq = config.price.max_freq
        var outside = getNibeData(hP['outside']).catch(console.log);
        var lock_freq_1 = getNibeData(hP['lock_freq_1_activate']).catch(console.log);
        var lock_freq_2 = getNibeData(hP['lock_freq_2_activate']).catch(console.log);
        var lock_freq_1_min = getNibeData(hP['lock_freq_1_min']).catch(console.log);
        var lock_freq_1_max = getNibeData(hP['lock_freq_1_max']).catch(console.log);
        var lock_freq_2_min = getNibeData(hP['lock_freq_2_min']).catch(console.log);
        var lock_freq_2_max = getNibeData(hP['lock_freq_2_max']).catch(console.log);
        Promise.all([lock_freq_1, lock_freq_2, lock_freq_1_min, lock_freq_1_max, lock_freq_2_min, lock_freq_2_max,outside]).then(async (values) => {
            lock_freq_1 = values[0]
            lock_freq_2 = values[1]
            lock_freq_1_min = values[2]
            lock_freq_1_max = values[3]
            lock_freq_2_min = values[4]
            lock_freq_2_max = values[5]
            outside = values[6]
            var frequency = scale(Number(outside.data.toFixed(0)), min_temp, max_temp, max_freq, min_freq)
            if(frequency!==undefined && frequency!==null && !isNaN(frequency)) {
                frequency = Number(frequency.toFixed(0))
                if(frequency<21) frequency = 21
                if(frequency>69) frequency = 69
                nibe.log(`Max frekvens som ska köras vid denna utomhustemperatur: ${frequency} hz`,'price','debug');
            } else {
                frequency = 21
                nibe.log(`Max frekvens som ska köras vid denna utomhustemperatur: Ställer in standard ${frequency} hz`,'price','debug');
            }
            if(frequency<21) frequency = 21
            if(frequency > lock_freq_1_min.data) {
                if(options.heat < 0) {
                    nibe.setData(hP['lock_freq_1_min'],frequency,(err,result) => {
                        if(err) {

                        } else {
                            nibe.setData(hP['lock_freq_1_activate'],"0",(err,result) => {
                                if(err) {
        
                                } else {
                                    nibe.setData(hP['lock_freq_1_activate'],"1")
                                }
        
                            });
                        }

                    });
                }

            } else if(frequency < lock_freq_1_min.data) {
                nibe.setData(hP['lock_freq_1_min'],frequency);
            }
            if(lock_freq_1_max.data!==70) nibe.setData(hP['lock_freq_1_max'],"70");
            if(lock_freq_2_min.data!==71) nibe.setData(hP['lock_freq_2_min'],"71");
            if(lock_freq_2_max.data!==120) nibe.setData(hP['lock_freq_2_max'],"120");
            if(options.heat < 0) {
                // Aktivera spärrband
                if(lock_freq_1.data!==1) nibe.setData(hP['lock_freq_1_activate'],"1");
                if(lock_freq_2.data!==1) nibe.setData(hP['lock_freq_2_activate'],"1");
                if(config.price.block_add===true) {
                    var dM = await getNibeData(hP['dM']).catch(console.log)
                    var dMaddstart = await getNibeData(hP['dMaddstart']).catch(console.log)
                    if(dMaddstart!==undefined) {
                        if(dM.data < (dMaddstart.data+50)) {
                            nibe.setData(hP['dM'],(dMaddstart.data+100));
                            nibe.log(`Förhindrar gradminuter från att starta tillsats`,'price','debug');
                        }
                    } else {
                        var dMadd = await getNibeData(hP['dMadd']).catch(console.log);
                        var dMstart = await getNibeData(hP['dMstart']).catch(console.log);
                        dMaddstart = dMstart.data-dMadd.data
                        if(dM.data < (dMaddstart.data+50)) {
                            nibe.setData(hP['dM'],(dMaddstart.data+100));
                            nibe.log(`Förhindrar gradminuter från att starta tillsats`,'price','debug');
                        }
                    }
                }
                resolve(frequency)
            } else if(options.heat >= 0) {
                // Avaktivera spärrband
                if(lock_freq_1.data!==0) nibe.setData(hP['lock_freq_1_activate'],"0");
                if(lock_freq_2.data!==0) nibe.setData(hP['lock_freq_2_activate'],"0");
                resolve(null)
            }
        }).catch(err => {
            console.log(err)
            reject(JSON.stringify(err,null,2))
        })
    } else {
        reject(`This model does not support slowing the frequency down.`)
    }
    
    });
    return promise;
}
const blockAdditive = (options) => {
    const promise = new Promise(async (resolve,reject) => {
    let config = nibe.getConfig();
    if(config.price===undefined) {
        config.price = {};
        nibe.setConfig(config);
    }
    if(config.system.pump!=="F370" && config.system.pump!=="F470") {
        if(options.heat < 0) {
            if(data.dM===undefined) {
                data.dM = await getNibeData(hP['dM']).catch(console.log);
            }
            getNibeData(hP['dMaddstart']).then(dMaddstart => {
                if(data.dM.data<data.dMstart.data+(-100)) {
                    nibe.setData(hP['dM'],(data.dMstart.data/2));
                    nibe.log(`Återställer gradminuter`,'price','debug');
                } else {
                    if(data.dM.data < (dMaddstart.data+50)) {
                        nibe.setData(hP['dM'],(dMaddstart.data+100));
                        nibe.log(`Förhindrar gradminuter från att starta tillsats`,'price','debug');
                    }
                }
            })
            .catch(async (err) => {
                data.dMadd = await getNibeData(hP['dMadd']).catch(console.log);
                let dMaddstart = data.dMstart.data-data.dMadd.data
                if(data.dM.data<data.dMstart.data+(-100)) {
                    nibe.setData(hP['dM'],(data.dMstart.data/2));
                    nibe.log(`Återställer gradminuter`,'price','debug');
                } else {
                    if(data.dM.data < (dMaddstart.data+50)) {
                        nibe.setData(hP['dM'],(dMaddstart.data+100));
                        nibe.log(`Förhindrar gradminuter från att starta tillsats`,'price','debug');
                    }
                }
            })
            
        }
    }
    
    });
    return promise;
}
    let hwSavedTemp = [];
    let hwTargetValue;
    async function hotwaterPlugin() {
        let time = Date.now();
        let hwTriggerTemp;
        let config = nibe.getConfig();
        if(config.hotwater===undefined) {
            config.hotwater = {};
            nibe.setConfig(config);
        }
        let hwON;
        let bt6;
        let bt7;
        let hwMode;
        let hwStartTemp;
        let hwStopTemp;
        let data = {};
        if(config.hotwater.enable_autoluxury===true || config.hotwater.enable_hw_priority===true) {      
            hwON = await getNibeData(hP['startHW']).catch(console.log);
            bt6 = await getNibeData(hP['bt6']).catch(console.log);
            bt7 = await getNibeData(hP['bt7']).catch(console.log);
            hwMode = await getNibeData(hP['hw_mode']).catch(console.log);
            hwStopTemp = await getNibeData(hP['hw_stop_'+hwMode.raw_data]).catch(console.log);
            data.bt6 = bt6;
            data.bt7 = bt7;
            data.hwMode = hwMode;
            hwStopTemp.data = hwStopTemp.data-1;
            data.hwStopTemp = hwStopTemp;
            saveDataGraph('hw_stop_temp',time,hwStopTemp.data,true);
            data.hwON = hwON;
        }
        if(config.hotwater.enable_autoluxury===true) {
            //if(hwON===undefined) {
            //    sendError('Varmvattenreglering',`Virtuell RMU ej aktiverad.`);
            //}
            let difference = Number(config.hotwater.diff);
            let diff_time = Number(config.hotwater.time);
            hwSavedTemp.unshift(bt6.data);
            //console.log(`Saving BT6 value, ${bt6.data} °C`)
            if(hwSavedTemp.length>=diff_time) {
                //console.log(JSON.stringify(hwSavedTemp));
                if(hwSavedTemp.length>diff_time) {
                    hwSavedTemp.splice(diff_time,hwSavedTemp.length);
                }
                hwTriggerTemp = hwSavedTemp.pop()
                hwTriggerTemp = hwTriggerTemp-difference;
            } else {
                //console.log(JSON.stringify(hwSavedTemp));
                hwTriggerTemp = hwSavedTemp[hwSavedTemp.length-1]
                hwTriggerTemp = hwTriggerTemp-difference;
            }
            hwTriggerTemp = Number(hwTriggerTemp.toFixed(2));
            //console.log(bt6.data+"<"+hwTriggerTemp)
            let hw_target_temp;
            if(hwON.raw_data!==4) {
                //if((clock>=config.hotwater.priority_time_start1 && clock<config.hotwater.priority_time_stop1) || clock>=config.hotwater.priority_time_start2) {
                    if(bt6.data<=hwTriggerTemp) {
                        hwTargetValue = hwTriggerTemp+difference-5;
                        hwTargetValue = Number(hwTargetValue.toFixed(2));
                        hw_target_temp = hwTargetValue;
                        //console.log(`Huge hotwater load. BT6 target value: ${hwTargetValue} °C, BT6 actual: ${bt6.data} °C`);
                        nibe.setData(hP['startHW'],4);
                    } else {
                        //console.log('Not huge hotwater load')
                    }
                //}
                
            } else {
                //console.log('Hotwater is already running luxury');
                if(hwTargetValue!==undefined) {
                    //console.log(`BT6 target value: ${hwTargetValue} °C, BT6 actual: ${bt6.data} °C`);
                    if(bt6.data>=hwTargetValue || bt6.data>=hwStopTemp.data) {
                        //console.log(`BT6 target (${hwTargetValue} °C) reached, BT6 actual: ${bt6.data} °C`);
                        hwTargetValue = undefined;
                        nibe.setData(hP['startHW'],0);
                    } else {
                        //console.log('Target temperature not reached yet.')
                    }
                }
            }
            if(hwTargetValue===undefined) {
                hw_target_temp = bt6.data;
            }
            data.hwTriggerTemp = hwTriggerTemp;
            data.hwTargetValue = hw_target_temp;

            saveDataGraph('hw_trigger_temp',time,hwTriggerTemp,true);
            saveDataGraph('hw_target_temp',time,hw_target_temp,true);
            nibeData.emit('pluginHotwaterAutoLuxury',data);
        }
        if(config.hotwater.enable_hw_priority===true) {
            hwStartTemp = await getNibeData(hP['hw_start_'+hwMode.data]).catch(console.log);
            hwStartTemp.timestamp = time;
            if(hwON.raw_data!==4) {
                if(bt7.data<=hwStartTemp.data) {
                    //console.log(`Start HW priority. BT7 target value: ${hwStopTemp.data} °C, BT7 actual: ${bt7.data} °C`);
                    nibe.setData(hP['startHW'],4);
                } else {
                    //console.log('Not starting HW priority')
                }
            } else {
                //console.log('Hotwater is already running luxury');
                    //console.log(`BT7 target value: ${hwStopTemp.data} °C, BT7 actual: ${bt7.data} °C`);
                    if(bt7.data>=hwStopTemp.data && hwTargetValue===undefined) {
                        //console.log(`BT7 target (${hwStopTemp.data} °C) reached, BT7 actual: ${bt7.data} °C`);
                        nibe.setData(hP['startHW'],0);
                    } else {
                        //console.log('Target temperature not reached yet.')
                    }
            }
            data.hwStartTemp = hwStartTemp;
            saveDataGraph('hw_start_temp',time,hwStartTemp.data,true);
            nibeData.emit('pluginHotwaterPriority',data);
        }
        
    }
let fan_mode;
let fan_mode_saved;
let flow_set;
let flow_saved;
let fan_saved;
let fan_filter_normal_eff;
let fan_filter_low_eff;
let filter_eff;
let dMboost = false;
let co2boost = false;
async function runFan() {
    async function checkBoost(data) {
        const promise = new Promise(async function (resolve,reject) {
        let config = nibe.getConfig();
        if(config.fan.enable_dm_boost!==undefined && config.fan.enable_dm_boost===true && config.system.pump!=="F370" && config.system.pump!=="F470") {
        data.dMadd = await getNibeData(hP['dMadd']).catch(console.log);
        data.dMaddstart = await getNibeData(hP['dMaddstart']).catch(console.log)
        data.dMstart = await getNibeData(hP['dMstart']).catch(console.log);
        if(data.dMaddstart===undefined) {
            data.dMaddstart = {}
            data.dMadd = await getNibeData(hP['dMadd']).catch(console.log);
            data.dMaddstart.data = data.dMstart.data-data.dMadd.data
            data.dMaddstart.raw_data = data.dMstart.raw_data-data.dMadd.raw_data
        }
        data.dM = await getNibeData(hP['dM']).catch(console.log);
            nibe.log(`Luftflödes boost vid låga gradminuter aktiverat.`,'fan','debug');
            if(config.fan.dm_boost_start===undefined || config.fan.dm_boost_start=="" || config.fan.dm_boost_start===0) {
                config.fan.dm_boost_start = 300;
                nibe.setConfig(config);
                nibe.log(`Inget standard värde för boosting, ställer 300 gradminuter som diff.`,'fan','debug');
            }
        let boost = (data.dMaddstart.data)+config.fan.dm_boost_start;
        nibe.log(`Boostvärde: ${boost}`,'fan','debug');
        if(boost>(data.dMstart.data-100)) {
            reject(new Error(`Startvärde för boost ligger för nära gradminuter vid start av kompressor, ${boost}>${data.dMstart.data-100}`))
        } else {
            var lock_freq_1 = await getNibeData(hP['lock_freq_1_activate']).catch(console.log);
            var lock_freq_2 = await getNibeData(hP['lock_freq_2_activate']).catch(console.log);

            if(data.dM.data<boost && lock_freq_1.data===0 && lock_freq_2.data===0) {
                nibe.log(`Gradminuter under gränsvärde för boost: ${boost}, Gradminuter: ${data.dM.data}`,'fan','debug');
                if(data.alarm.raw_data!==183) {
                    if(config.fan.dm_boost_value!==undefined && config.fan.dm_boost_value!=="" && config.fan.dm_boost_value!==0) {
                        if(fan_mode!='dMboost') {
                            fan_mode_saved = fan_mode
                            fan_mode = 'dMboost'
                            dMboost = true;
                            fan_saved = data.fan_speed.raw_data;
                            nibe.log(`Sparar fläkthastighet vid första upptäckt av forcering med gradminut boost, värde: ${fan_saved}%`,'fan','debug');
                        }
                        resolve(true)
                    } else {
                        reject(new Error('Inget boostvärde angivet'))
                    }
                } else {
                    nibe.log(`Gradminutboost uppfylld, men avfrostning pågår.`,'fan','debug');
                    reject();
                }
            } else if(lock_freq_1.data===1 && lock_freq_2.data===1) {
                dMboost = false;
                fan_mode = fan_mode_saved
                nibe.log(`Blockering av hög kompressorfrekvens pågår via elprisreglering`,'fan','debug');
                reject();
            } else if(data.dM.data>(boost+50)) {
                dMboost = false;
                fan_mode = fan_mode_saved
                nibe.log(`Gradminuter över gränsvärde för boost: ${boost+50}, Gradminuter: ${data.dM.data}`,'fan','debug');
                reject();
            } else {
                if(fan_mode=='dMboost') {
                    nibe.log(`Gradminuter under gränsvärde för boost, på väg mot stopp: ${boost}, Gradminuter: ${data.dM.data}`,'fan','debug');
                    resolve(true)
                } else {
                    dMboost = false;
                    fan_mode = fan_mode_saved
                    nibe.log(`Gradminuter över gränsvärde för boost: ${boost}, Gradminuter: ${data.dM.data}`,'fan','debug');
                    reject();
                }
            }
        }
    } else {
        dMboost = false;
        nibe.log(`Luftflödes boost vid låga gradminuter ej aktiverat.`,'fan','debug');
        reject();
    }
    if(fan_mode!=="dMboost" && fan_mode_saved=="dMboost") {
        if(data.alarm.raw_data!==183) {
            if(fan_saved!==undefined) {
                nibe.setData(hP.fan_speed,fan_saved);
                data.fan_speed.raw_data = fan_saved;
                nibe.log(`Återställer fläkthastighet (${fan_saved}%)`,'fan','debug');
            }
            if(config.fan[`speed_${fan_mode_saved}`]!==undefined) flow_set = config.fan[`speed_${fan_mode_saved}`];
            nibe.log(`Ställer in ${fan_mode_saved} luftflöde: ${config.fan[`speed_${fan_mode_saved}`]} m3/h`,'fan','debug');
        } else {
            nibe.log(`Avfrostning pågår, avvaktar, sparad fläkthastighet (${fan_saved}%)`,'fan','debug');
        }
    }
    });
    return promise;
    }
    let config = nibe.getConfig();
    var data = {};
    var timeNow = Date.now();
    if(config.fan===undefined) { config.fan = {}; nibe.setConfig(config); }
    if(config.home.inside_sensors===undefined) { config.home.inside_sensors = []; nibe.setConfig(config); }
    if(config.fan.enable!==true) {
        // Function turned off, stopping.
        return;
    }
    data.temp_fan_speed = await getNibeData(hP['fan_mode']).catch(console.log);
    if(data.temp_fan_speed===undefined) {
        nibe.log('Ingen data från fläktforceringsregister. Avbryter...','fan','error');
        return;
    }
    
    data.co2Sensor;
    data.fan_speed = await getNibeData(hP['fan_speed']).catch(console.log);
    data.bs1_flow = await getNibeData(hP['bs1_flow']).catch(console.log);
    // Check if bug with saving 0% resolves if(flow_set===undefined) flow_set = data.bs1_flow.raw_data;
    data.alarm = await getNibeData(hP['alarm']).catch(console.log);
    data.evaporator = await getNibeData(hP['evaporator']).catch(console.log);
    data.cpr_set = await getNibeData(hP['cpr_set']).catch(console.log);
    
    if(config.fan.enable_co2===true) {
    if(config.fan.sensor===undefined || config.fan.sensor=="Ingen") {
        nibe.log('CO2 givare inte vald.','fan','error');
    } else {
        let index = config.home.inside_sensors.findIndex(i => i.name == config.fan.sensor);
        if(index!==-1) {
            nibe.log('CO2 givare hittad.\n'+JSON.stringify(data.co2Sensor,null,2),'fan','debug');
            data.co2Sensor = Object.assign({}, config.home.inside_sensors[index]);
        } else {
            nibe.log('CO2 givare inte hittad.','fan','debug');
        }
    }
    if(data.co2Sensor!==undefined) {
        if(data.co2Sensor.source=="mqtt") {
            await nibe.getMQTTData(data.co2Sensor.register).then(atad => {
                let result = Object.assign({}, atad);
                nibe.log('Data från CO2 givare\n',result.data,'fan','debug');
                let sensor_timeout;
                if(config.home.sensor_timeout!==undefined && config.home.sensor_timeout!=="") {
                    sensor_timeout = result.timestamp+(config.home.sensor_timeout*60000);
                    nibe.log('Timeout vald för sensor, tid:'+config.home.sensor_timeout+" minuter",'fan','debug');
                } else if(config.home.sensor_timeout===0) {
                    sensor_timeout = timeNow;
                    nibe.log('Timeout är avvaktiverad för sensor','fan','debug');
                } else {
                    sensor_timeout = result.timestamp+(60*60000);
                    nibe.log('Timeout ej vald, sätter standard tid 60 minuter','fan','debug');
                }
                if(timeNow>sensor_timeout) {
                    nibe.log(`CO2 givare ${data.co2Sensor.name} har inte uppdaterats. Ignorerar.`,'fan','error');
                } else {
                    nibe.log(`CO2 givare ${data.co2Sensor.name} värde:${result.data}`,'fan','debug');
                    data.co2Sensor.data = result;
                    data.co2Sensor.data.timestamp = timeNow;
                    saveDataGraph('fan_co2Sensor',timeNow,data.co2Sensor.data.data,true)
                }
                
            },(error => {
                nibe.log(`CO2 givare ${data.co2Sensor.name} har inga värden än.`,'fan','error');
            }));
        } else if(data.co2Sensor.source=="tibber") {
            console.log('Tibber Data request');
        }
    }
}
    // Check if co2 wants boosting
        if(config.fan.enable_co2===true && config.fan.enable_high) {
            if(data.alarm.raw_data!==183) {
                nibe.log(`CO2 boosting aktiverad`,'fan','debug');
                if(config.fan.high_co2_limit===undefined || config.fan.high_co2_limit=="" || config.fan.high_co2_limit===0) {
                    nibe.log(`Inget standard värde för boosting, ställer in 1000 ppm`,'fan','debug');
                    config.fan.high_co2_limit = 1000;
                    nibe.setConfig(config);
                }
                data.high_co2_limit = config.fan.high_co2_limit;
                saveDataGraph('fan_high_co2_limit',timeNow,config.fan.high_co2_limit,true);
                if(data.co2Sensor!==undefined && data.co2Sensor.data!==undefined) {
                    data.co2Sensor.data.data = Number(data.co2Sensor.data.data);
                    if(data.co2Sensor.data.data>config.fan.high_co2_limit) {
                        nibe.log(`CO2 givares värde (${data.co2Sensor.data.data}) över gränsvärde ${config.fan.high_co2_limit}`,'fan','debug');
                        if(config.fan.speed_high!==undefined && config.fan.speed_high!="" && config.fan.speed_high!==0) {
                            if(fan_mode!='co2boost') {
                                fan_mode_saved = fan_mode
                                fan_mode = 'co2boost'
                                co2boost = true;
                            }
                            flow_set = config.fan.speed_high;
                            if(fan_mode!=="co2boost") {
                                fan_saved = data.fan_speed.raw_data;
                                nibe.log(`Sparar fläkthastighet vid första upptäckt av forcering med CO2, värde: ${fan_saved}%`,'fan','debug');
                            }
                            nibe.log(`Ställer in högt luftflöde: ${config.fan.speed_high} m3/h`,'fan','debug');
                            dMboost = false;
                        } else {
                            nibe.log(`Inget luftflöde valt för boosting.`,'fan','error');
                        }
                    } else {
                        nibe.log(`CO2 givares värde (${data.co2Sensor.data.data}) under gränsvärde ${config.fan.high_co2_limit}`,'fan','debug');
                        
                        if(data.alarm.raw_data!==183) {
                            if(fan_saved!==undefined) {
                                nibe.setData(hP.fan_speed,fan_saved);
                                data.fan_speed.raw_data = fan_saved;
                                nibe.log(`Återställer fläkthastighet (${fan_saved}%)`,'fan','debug');
                            }
                            if(config.fan[`speed_${fan_mode_saved}`]!==undefined) flow_set = config.fan[`speed_${fan_mode_saved}`];
                            fan_mode = fan_mode_saved;
                            nibe.log(`Ställer in ${fan_mode_saved} luftflöde: ${config.fan[`speed_${fan_mode_saved}`]} m3/h`,'fan','debug');
                        } else {
                            nibe.log(`Avfrostning pågår, avvaktar, sparad fläkthastighet (${fan_saved}%)`,'fan','debug');
                        }
                    }
                } else {
                    nibe.log(`Inget värde på CO2 givare`,'fan','error');
                }
            } else {
                nibe.log(`Avfrostning pågår. Avvaktar.`,'fan','debug');
            }
    } else {
        nibe.log(`CO2 boosting ej aktiverad.`,'fan','debug');
    }
    if(fan_mode!=="co2boost") {
        co2boost = false;
        await checkBoost(data).then(result => {
            nibe.log(`Villkor för gradminutboosting uppfyllda.`,'fan','debug');
            flow_set = config.fan.dm_boost_value;
            
        },(err => {
            if(err) {
                //nibe.log(err,'fan','error');
            } else {
                if(config.fan.enable_low===true && data.cpr_set.raw_data<config.fan.low_cpr_freq) {
                    nibe.log(`Kompressorfrekvens under gränsvärde`,'fan','debug');
                    if(data.alarm.raw_data!==183) {
                        if(config.fan.enable_co2===true) {
                            nibe.log(`CO2 styrning aktiverad.`,'fan','debug');
                            if(data.co2Sensor!==undefined && data.co2Sensor.data!==undefined) {
                                nibe.log(`Värde finns från CO2 givare`,'fan','debug');
                                data.co2Sensor.data.data = Number(data.co2Sensor.data.data);
                                if(config.fan.low_co2_limit===undefined || config.fan.low_co2_limit=="" || config.fan.low_co2_limit===0) {
                                    config.fan.low_co2_limit = 800;
                                    nibe.setConfig(config);
                                    nibe.log(`Inget standard värde för CO2 valt, sätter 800 ppm.`,'fan','debug');
                                }
                                data.low_co2_limit = config.fan.low_co2_limit;
                                saveDataGraph('fan_low_co2_limit',timeNow,config.fan.low_co2_limit,true);
                                if(data.co2Sensor.data.data<config.fan.low_co2_limit) {
                                    if(fan_mode=="low") {
                                        flow_set = config.fan.speed_low;
                                        nibe.log(`CO2 givares värde (${data.co2Sensor.data.data}) ppm under gränsvärde för att kunna forcera låg fläkthastighet (${config.fan.low_co2_limit} ppm)`,'fan','debug');
                                    } else {
                                        if(fan_mode==="normal") {
                                            fan_saved = data.fan_speed.raw_data;
                                            nibe.log(`Sparar fläkthastighet vid första upptäckt av låg frekvens med CO2, värde: ${fan_saved}%`,'fan','debug');
                                        }
                                        fan_mode = "low";
                                    }
                                } else {
                                    if(fan_mode=="normal") {
                                        flow_set = config.fan.speed_normal;
                                        nibe.log(`CO2 givares värde (${data.co2Sensor.data.data}) ppm över gränsvärde för att kunna forcera låg fläkthastighet (${config.fan.low_co2_limit} ppm)`,'fan','debug');
                                    } else {
                                        fan_mode = "normal";
                                        nibe.log(`CO2 givares värde (${data.co2Sensor.data.data}) ppm över gränsvärde men avvaktar en cykel (${config.fan.low_co2_limit} ppm`,'fan','debug');
                                    }
                                }
                            } else {
                                    nibe.log(`Inget värde på CO2 givare, ställer in normalt luftflöde: ${config.fan.speed_normal} m3/h`,'fan','debug');
                                    flow_set = config.fan.speed_normal;
                                    fan_mode = "normal";                            
                            }
                        } else {
                            nibe.log(`CO2 styrning ej aktiverad`,'fan','debug');
                            if(config.fan.speed_low!==undefined && config.fan.speed_low!=="" && config.fan.speed_low!==0) {
                                if(fan_mode=="low") {
                                    flow_set = config.fan.speed_low;
                                    nibe.log(`Ställer in lågt luftflöde: ${config.fan.speed_low} m3/h`,'fan','debug');
                                } else {
                                    if(fan_mode==="normal") {
                                        fan_saved = data.fan_speed.raw_data;
                                        nibe.log(`Sparar fläkthastighet vid första upptäckt av låg frekvens, värde: ${fan_saved}%`,'fan','debug');
                                    }
                                    fan_mode = "low";
                                }
                            } else {
                                nibe.log(`Inget värde på lågt luftflöde`,'fan','debug');
                            }
                        }
                    } else {
                        nibe.log(`Avfrostning pågår, avvaktar.`,'fan','debug');
                    }
                } else {
                        if(fan_mode=="low") {
                            nibe.log(`Kompressorfrekvens över gränsvärde och föregående läge var låg frekvens.`,'fan','debug');
                            if(data.alarm.raw_data!==183) {
                                if(fan_saved!==undefined) {
                                    nibe.setData(hP.fan_speed,fan_saved);
                                    data.fan_speed.raw_data = fan_saved;
                                    nibe.log(`Återställer fläkthastighet (${fan_saved}%)`,'fan','debug');
                                }
                                flow_set = config.fan.speed_normal;
                                fan_mode = "normal";
                                nibe.log(`Ställer in normalt luftflöde: ${config.fan.speed_normal} m3/h`,'fan','debug');
                            } else {
                                nibe.log(`Avfrostning pågår, avvaktar, sparad fläkthastighet (${fan_saved}%)`,'fan','debug');
                            }
                        } else {
                            nibe.log(`Villkor uppfyllda för normalt luftflöde: ${config.fan.speed_normal} m3/h`,'fan','debug');
                            if(data.alarm.raw_data!==183) {
                                flow_set = config.fan.speed_normal;
                                fan_mode = "normal";
                                nibe.log(`Ställer in normalt luftflöde: ${config.fan.speed_normal} m3/h`,'fan','debug');
                            } else {
                                nibe.log(`Avfrostning pågår, avvaktar...`,'fan','debug');
                            }
                        }
                }
            }
        }));
    }
    
    
    // Start regulating only if not defrosting and vented air is above freezing temperatures.
    if((data.alarm.raw_data!==183 && data.evaporator.raw_data>0 && data.temp_fan_speed!==undefined && data.temp_fan_speed.raw_data===0)) {
        if(flow_set<30) {
            nibe.log(`För lågt luftflöde inställt, avbryter.`,'fan','error');
            return;
        }
        if(flow_set===undefined) {
            nibe.log(`Inget börvärde på flöde, avvaktar...`,'fan','error');
            return;
        }
        nibe.log(`Villkor uppfyllda för reglering av flöde.`,'fan','debug');
        nibe.log(`Flowset: ${flow_set}, Flöde: ${data.bs1_flow.raw_data}, Flowsaved: ${flow_saved}`,'fan','debug');
        if(fan_mode!=="dMboost" && fan_mode!=="co2boost" && fan_mode!=="low" && data.bs1_flow.raw_data>(flow_set+25) && (flow_saved===undefined || data.bs1_flow.raw_data>flow_saved+25)) {
            nibe.log(`Luftflöde långt över börvärde: ${flow_set}, Flöde: ${data.bs1_flow.raw_data} m3/h, Forcering pågår`,'fan','debug');
        } else if(data.bs1_flow.raw_data>(flow_set+20)) {
            if(data.fan_speed.raw_data-5>10) {
                nibe.log(`Luftflöde långt över gränsvärde: ${flow_set+20}, Flöde: ${data.bs1_flow.raw_data} m3/h, -5%`,'fan','debug');
                nibe.setData(hP.fan_speed,(data.fan_speed.raw_data-5));
            } else if(data.fan_speed.raw_data>10) {
                nibe.log(`Luftflöde långt över gränsvärde: ${flow_set+20}, Flöde: ${data.bs1_flow.raw_data} m3/h, -1%`,'fan','debug');
                nibe.setData(hP.fan_speed,(data.fan_speed.raw_data-1));
            }
        } else if(data.bs1_flow.raw_data>(flow_set+10)) {
            nibe.log(`Luftflöde över gränsvärde: ${flow_set+10}, Flöde: ${data.bs1_flow.raw_data} m3/h, -1%`,'fan','debug');
            if(data.fan_speed.raw_data>0) nibe.setData(hP.fan_speed,(data.fan_speed.raw_data-1));
        } else if(data.bs1_flow.raw_data<(flow_set-20)) {
            if(data.fan_speed.raw_data+5<100) {
                nibe.log(`Luftflöde långt under gränsvärde: ${flow_set+20}, Flöde: ${data.bs1_flow.raw_data} m3/h, +5%`,'fan','debug');
                nibe.setData(hP.fan_speed,(data.fan_speed.raw_data+5));
            } else if(data.fan_speed.raw_data<100) {
                nibe.log(`Luftflöde långt under gränsvärde: ${flow_set+20}, Flöde: ${data.bs1_flow.raw_data} m3/h, +1%`,'fan','debug');
                nibe.setData(hP.fan_speed,(data.fan_speed.raw_data+1));
            }
        } else if(data.bs1_flow.raw_data<(flow_set-10)) {
            nibe.log(`Luftflöde under gränsvärde: ${flow_set+10}, Flöde: ${data.bs1_flow.raw_data} m3/h, +1%`,'fan','debug');
            if(data.fan_speed.raw_data<100) nibe.setData(hP.fan_speed,(data.fan_speed.raw_data+1));
        } else {
            nibe.log(`Luftflöde stabilt (${data.bs1_flow.raw_data} m3/h)`,'fan','debug');
            dMboost = false;
            co2boost = false;
            flow_saved = data.bs1_flow.raw_data;
            if(config.fan.enable_filter===true) {
                nibe.log(`Filterkontroll är aktiverad`,'fan','debug');
            // Value is stable, save fan speeds if calibration is active.
            if(fan_mode=="low") {
                if(config.fan.filter_value_low===-1) {
                    config.fan.filter_value_low = data.fan_speed.raw_data;
                    nibe.setConfig(config);
                } else {
                    if(config.fan.filter_value_low!==undefined && config.fan.filter_value_low!="") {
                        let saved = config.fan.filter_value_low;
                        fan_filter_low_eff = Number(((saved/data.fan_speed.raw_data)*100).toFixed(0));
                    }
                }
            } else if(fan_mode=="normal") {
                if(config.fan.filter_value_normal===-1) {
                    config.fan.filter_value_normal = data.fan_speed.raw_data;
                    nibe.setConfig(config);
                } else {
                    if(config.fan.filter_value_normal!==undefined && config.fan.filter_value_normal!="") {
                        let saved = config.fan.filter_value_normal;
                        fan_filter_normal_eff = Number(((saved/data.fan_speed.raw_data)*100).toFixed(0));
                    }
                    
                }
            }
            fan_mode = undefined;
            if(fan_filter_low_eff!==undefined && fan_filter_normal_eff===undefined) {
                filter_eff = Number((fan_filter_low_eff).toFixed(0));
                if(filter_eff>100) filter_eff = 100;
            } else if(fan_filter_low_eff===undefined && fan_filter_normal_eff!==undefined) {
                filter_eff = Number((fan_filter_normal_eff).toFixed(0));
                if(filter_eff>100) filter_eff = 100;
            } else if(fan_filter_low_eff!==undefined && fan_filter_normal_eff!==undefined) {
                filter_eff = Number(((fan_filter_low_eff+fan_filter_normal_eff)/2).toFixed(0));
                if(filter_eff>100) filter_eff = 100;
            } else {

            }
            }
        }
    } else {
        if(co2boost===false) nibe.log(`Villkor för reglering ej uppfyllt, CO2 boost inte över gränsvärde`,'fan','debug');
        if(dMboost===false) nibe.log(`Villkor för reglering ej uppfyllt, Gradminutboost inte under gränsvärde`,'fan','debug');
        if(data.alarm.raw_data===183) nibe.log(`Villkor för reglering ej uppfyllt, avfrostning pågår.`,'fan','debug');
        if(data.evaporator.raw_data<0) nibe.log(`Villkor för reglering ej uppfyllt, förångaren för kall (${data.evaporator.raw_data})`,'fan','debug');
        if(data.temp_fan_speed!==undefined && data.temp_fan_speed.raw_data!==0) nibe.log(`Villkor för reglering ej uppfyllt, Tillfällig fläktforcering pågår. värde: ${data.temp_fan_speed.raw_data}`,'fan','debug');
    }
    data.cpr_act = await getNibeData(hP['cpr_act']).catch(console.log);
    saveDataGraph('fan_setpoint',timeNow,flow_set,true);
    saveDataGraph('filter_eff',timeNow,filter_eff,true);
    data.filter_eff = filter_eff;
    data.setpoint = flow_set;
    nibeData.emit('pluginFan',data);
}
async function runRMU(result,array) {
    let config = nibe.getConfig();
    var data = Object.assign({}, result);
    if(config.rmu===undefined) config.rmu = {};
    for( var i = 1; i < 5; i++){
        data.system = "s"+i;
        let inside;
        if(config.rmu['sensor_s'+i]!==undefined && config.rmu['sensor_s'+i]!=="") {
            let ind = array.findIndex(index => index.name == config.rmu['sensor_s'+i]);
            if(ind!==-1) inside = array[ind];
        }
        let register = nibe.getRegister();
        let sensor = register.find(index => index.register == hP['rmu_sensor_s'+i]);
        if(sensor!==undefined && sensor.mode=="R/W") {
            if(inside!==undefined) {
                nibe.setData(hP['rmu_sensor_s'+i],inside.data);
            } else {
                sendError(`RMU40 System ${i}`,`Givare har inga värden, avbryter...`);
                return;
            }
            data.rmuSensor = inside;
            nibeData.emit('pluginRMU',data);
        } else {

        }
    }
}
async function getNibeData(register) {
    const promise = new Promise((resolve,reject) => {
    if(savedData[register]===undefined || Date.now()>(savedData[register].timestamp+30000)) {
        nibe.reqData(register).then(atad => {
            let data = Object.assign({}, atad);
            resolve(data);
        }).catch(err => {
            reject(err);
        });
    } else {
        resolve(savedData[register]);
    }
});
return promise;
}
isObject = function(a) {
    return (!!a) && (a.constructor === Object);
};
function saveDataGraph(name,ts,data,save=false) {
    function isValid(data) {
        if(data!==undefined) {
            //First data, saving.
            if(isObject(data)===true) {
                return true;
            } else {
                if(data>-3276) {
                    return true;
                } else {
                    return false;
                    //Invalid first data, not saving.
                }
            }
        } else {
            return false;
        }
    }
    if(savedGraph[name]===undefined) savedGraph[name] = [];
    let lastIndex = savedGraph[name].length-1;
    if(savedGraph[name].length>=2) {
        if(ts>=(savedGraph[name][lastIndex].x+55000)) {
            if(isValid(data)===true) {
                if((Math.abs(savedGraph[name][lastIndex].y-data)>0.1)) {
                    savedGraph[name].push({x:ts,y:data});
                } else {
                    if(savedGraph[name][lastIndex-1].y===data) {
                        savedGraph[name][lastIndex].x = ts;
                    } else {
                        savedGraph[name].push({x:ts,y:data});
                    }
                    
                }
            }
        } else {
            // Check if the timestamp match saved timestamp.
            if(isValid(data)===true) {
                let index = savedGraph[name].findIndex(i => i.x == ts);
                if(index!==-1) {
                    savedGraph[name][index].y = data;
                }
            }
        }
    } else {
        if(isValid(data)===true) savedGraph[name].push({x:ts,y:data});
    }
    if(save===true) {
        savedData[name] = {data:data,raw_data:data,timestamp:ts};
    }
    
}
const gethP  = () => {
    return hP;
}
function getSavedData() {
    return savedData;
}
function getSavedGraph() {
    return savedGraph;
}
function getSystems() {
    return systems;
}
let defrostTimer = 60000;
let defrosting;
let cpr_running;
let defrost_saved;
let runTime;
let savedRunTime = Date.now();
async function checkEfficiency(runtime,defrost) {
    let time = Date.now();
    let total = runtime+defrost;
    let uptime = Number((runtime/total*100).toFixed(0));
    let downtime = 100-uptime;
    saveDataGraph('cpr_uptime',time,uptime,true);
    saveDataGraph('cpr_downtime',time,downtime,true);
}
async function runDiagnostic() {
    nibe.log(`Running diagnostic`,'diagnostic','debug');
    async function uptimeCheck() {
        getNibeData(hP['cpr_act']).then(cpr => {
            if(cpr.data>=1) {
                if(cpr_running===undefined) {
                    saveDataGraph('cpr_runtime',Date.now(),Number(((Date.now()-savedRunTime)/60000).toFixed(0)),true);
                } else if(cpr_running===false) {
                    nibe.log(`Compressor just started.`,'diagnostic','debug');
                    if(runTime!==undefined && defrost_saved!==undefined) {
                        nibe.log(`Cycle completed. Run time: ${(runTime/60000).toFixed()} minutes, Defrost time: ${(defrost_saved/60).toFixed(0)}`,'diagnostic','debug');
                        checkEfficiency(Number((runTime/1000).toFixed(0)),defrost_saved);
                        saveDataGraph('cpr_efficiency',Date.now(),{uptime:Number((runTime/1000).toFixed(0)),defrost:defrost_saved},true);
                        runTime = undefined;
                        defrost_saved = undefined;
                    }
                    savedRunTime = Date.now();
                    saveDataGraph('cpr_runtime',Date.now(),Number(((Date.now()-savedRunTime)/60000).toFixed(0)),true);
                    cpr_running = true;
                    
                } else {
                    nibe.log(`Compressor running.`,'diagnostic','debug');
                    saveDataGraph('cpr_runtime',Date.now(),Number(((Date.now()-savedRunTime)/60000).toFixed(0)),true);
                }
            } else {
                if(cpr_running===undefined) {
                    nibe.log(`Compressor not running at startup`,'diagnostic','debug');
                    cpr_running = false;
                } else if(cpr_running===true) {
                    runTime = Date.now()-savedRunTime;
                    nibe.log(`Compressor just shutdown. Run time: ${(runTime/60000).toFixed(0)} minutes`,'diagnostic','debug');
                    cpr_running = false;
                }
                saveDataGraph('cpr_runtime',Date.now(),0,true);
            }
        }).catch(console.log);
    }
    async function defrostCheck() {
        if(timer.diagnostic!==undefined && timer.diagnostic._idleTimeout>0) {
            clearTimeout(timer.diagnostic);
        }
        nibe.log(`Defrost timer running...`,'diagnostic','debug');
        getNibeData(hP['defrost_time']).then(defrost => {
            nibe.log(`Got defrost data: ${defrost.data} sec`,'diagnostic','debug');
            if(defrost.data>0) {
                defrostTimer = 10000;
                defrost_saved = defrost.data;
                nibe.log(`Defrost is active!, checking again in ${defrostTimer/1000} sec`,'diagnostic','debug');
                saveDataGraph('defrosting',Date.now(),Number((defrost.data/60).toFixed(0)),true);
                saveDataGraph('cpr_runtime',Date.now(),0,true);
            } else {
                if(defrost_saved===undefined) {
                    defrost_saved = defrost.data;
                }
                saveDataGraph('defrosting',Date.now(),0,true);
                defrostTimer = 60000;
                nibe.log(`Defrost is inactive, checking again in ${defrostTimer/1000} sec`,'diagnostic','debug');
            }
            if(timer.diagnostic===undefined || timer.diagnostic._idleTimeout===-1) {
                timer.diagnostic = setTimeout(defrostCheck, defrostTimer);
            }
        }).catch(err => {
            nibe.log(`No defrost data.`,'diagnostic','debug');
            defrostTimer = 60000;
            if(timer.diagnostic===undefined || timer.diagnostic._idleTimeout===-1) {
                timer.diagnostic = setTimeout(defrostCheck, defrostTimer);
            }
        })
        uptimeCheck();
    }
    let config = nibe.getConfig();
    if(config.system===undefined) {
        config.system = {};
        nibe.setConfig(config);
    }
    if(config.system.pump!==undefined && (config.system.pump=="F730" || config.system.pump=="F750")) {
        nibe.log(`Heatpump is supported, starting defrost check timer, timer: ${defrostTimer/1000} sec`,'diagnostic','debug');
        if(timer.diagnostic===undefined || timer.diagnostic._idleTimeout===-1) {
            timer.diagnostic = setTimeout(defrostCheck, defrostTimer);
        }
    } else {
        nibe.log(`Heatpump is not supported`,'diagnostic','debug');
    }
}
async function tenMinuteUpdate() {
    let config = nibe.getConfig();
    if(config.system.auto_update===undefined || config.system.auto_update===true) {
        getNibeData(hP['inside_set_s1']).catch(console.log);
        if(systems!==undefined && systems.s2===true) {
            getNibeData(hP['inside_set_s2']).catch(console.log);
        }
    }
}
async function minuteUpdate() {
    let config = nibe.getConfig();
    if(config.system.auto_update===undefined) {
        config.system.auto_update = true;
        nibe.setConfig(config);
    }
    if(config.system.auto_update===true) {
        getNibeData(hP['outside']).catch(console.log);
        getNibeData(hP['inside_s1']).catch(console.log);
        getNibeData(hP['curveadjust_s1']).catch(console.log);
        getNibeData(hP['setpoint_s1']).catch(console.log);
        getNibeData(hP['supply_s1']).catch(console.log);
        if(systems!==undefined && systems.s2===true) {
            getNibeData(hP['inside_s2']).catch(console.log);
            getNibeData(hP['curveadjust_s2']).catch(console.log);
            getNibeData(hP['setpoint_s2']).catch(console.log);
            getNibeData(hP['supply_s2']).catch(console.log);
        }
    }
}
const checkTranslation = (node) => {
    let config = nibe.getConfig();
    if(config.system===undefined) {
        config.system = {language:"SE"};
        nibe.setConfig(config);
    }
    if(config.system.language===undefined) {
        config.system.language = "SE";
        nibe.setConfig(config);
    }
    text = require(`./language-${config.system.language}.json`)
    node.context().global.set(`translate`, translate);
}
    console.log(text.starting)

    function nibeConfig(n) {
        RED.nodes.createNode(this,n);
        var cron = require('node-cron');
        let config = nibe.getConfig();
        if(config.price===undefined) {
            config.price = {};
            nibe.setConfig(config);
            nibe.log(`Sätter config för första gången för elprisregleringen.`,'price','debug');
        }
        if(config.price.enable_freq===undefined) {
            config.price.enable_freq = false
            config.price.block_add = false
            config.price.enable_dM_reset = false
            config.price.min_freq = 21
            config.price.max_freq = 35
            config.price.min_temp = -20
            config.price.max_temp = 0
            nibe.setConfig(config);
            nibe.log(`Sätter config för Elprisreglering till standardvärden för frekvensstyrning`,'price','debug');
        }
        nibeData.emit('config',nibe.getConfig());
        checkTranslation(this);
        const handleMQTT = (config) => {
            if(config.mqtt===undefined) config.mqtt = {};
            nibe.handleMQTT(config.mqtt.enable,config.mqtt.host,config.mqtt.port,config.mqtt.user,config.mqtt.pass, (err,result) => {
                if(err) this.warn(err);
                if(result===true) {
                    //console.log('MQTT broker is connected')
                } else {
                    //console.log('MQTT broker is disconnected')
                }
            })
        }
        
        const handleCore = (config,force=false) => {
            if(config.connection===undefined) config.connection = {};
            if(config.serial===undefined) config.serial = {};
            if(config.tcp===undefined) config.tcp = {};
            console.log(`Heatpump Series: ${config.connection.series}`);
            if(config.connection.series=="fSeries") {
                hP = require('./dataregister.json').fSeries;
            } else if(config.connection.series=="sSeries") {
                hP = require('./dataregister.json').sSeries;
            } else {
                hP;
            }
            if(tcp_host!==config.tcp.host || tcp_port!==config.tcp.port || serialPort!==config.serial.port || series!==config.connection.series || force===true) {
                nibe.stopCore(nibe.core).then(result => {
                    nibe.resetCore();
                    if(config.connection.series=="fSeries") {
                    if(config.serial.port!=="" && config.serial.port!==undefined && (config.connection.enable==="serial" || config.connection.enable==="nibegw")) {
                        if(nibe.core===undefined || nibe.core.connected===undefined || nibe.core.connected===false) {
                            initiateCore(null,config.serial.port, async (err,result)=> {
                                if(err) console.log(err);
                                let config = nibe.getConfig();
                                if(config.system===undefined) {
                                    config.system = {};
                                    nibe.setConfig(config);
                                }
                                var c1 = await getNibeData('40047').catch(console.log)
                                if(c1!==undefined && c1.data > 0) {
                                    hP.supply_s1 = "40047";
                                    console.log('Register 40047 found, using it for supply temp S1')
                                }
                                var c2 = await getNibeData('40071').catch(console.log)
                                if(c2!==undefined && c2.data > 0)  {
                                    hP.supply_s1 = "40071";
                                    console.log('Register 40071 found, using it for supply temp S1')
                                }
                                
                                //if(config.system.pump=="F750") hP.supply_s1 = "40047";
                                //if(config.system.pump=="F1345") hP.supply_s1 = "40071";
                                sendError('Kärnan',`Nibe ${config.system.pump} är ansluten`);
                                console.log('Core is connected');
                                updateData(true);
                                nibe.redOn();
                                this.register = nibe.getRegister();
                                this.context().global.set(`register`, this.register);
                                nibeData.emit('ready',true);
                            })
                        }
                    }
                } else if(config.connection.series=="sSeries") {
                    if(config.tcp.host!==undefined && config.tcp.host!=="" && config.tcp.port!==undefined && config.tcp.port!=="" && config.connection.enable==="tcp") {
                        if(nibe.core===undefined || nibe.core.connected===undefined || nibe.core.connected===false) {
                            initiateCore(config.tcp.host,config.tcp.port, (err,result)=> {
                                if(err) console.log(err);
                                let config = nibe.getConfig();
                                if(config.system===undefined) {
                                    config.system = {};
                                    nibe.setConfig(config);
                                }
                                sendError('Kärnan',`Nibe ${config.tcp.pump} är ansluten`);
                                console.log('Core is connected');
                                updateData(true);
                                nibe.redOn();
                                this.register = nibe.getRegister();
                                this.context().global.set(`register`, this.register);
                                nibeData.emit('ready',true);
                            })
                        }
                    }
                }
                });
                }
            serialPort = config.serial.port;
            series = config.connection.series;
            tcp_host = config.tcp.host;
            tcp_port = config.tcp.port;
        }
        const checkReady = (cb) => {
            if(nibe.core!==undefined && nibe.core.connected!==undefined && nibe.core.connected===true) {
                cb(null,nibe.core.connected);
            }
        }
        if(nibe.core!==undefined && nibe.core.connected!==undefined && nibe.core.connected===true) {
            runDiagnostic();
        } else {
            nibeData.on('ready', (data) => {
                runDiagnostic();
            })
        }
        handleCore(nibe.getConfig());
        handleMQTT(nibe.getConfig());
        nibe.requireGraph().then(result => {
            let config = nibe.getConfig();
            if(config.system===undefined || config.system.save_graph!==true) return;
            if(result===undefined) return;
            savedGraph = result;
            //this.context().global.set(`graphs`, result);
        },(err => {

        }));
        
        RED.httpAdmin.post("/config/:id", RED.auth.needsPermission("nibe-config.write"), function(req, res) {
            nibe.setConfig(req.body.config);
            handleCore(req.body.config);
            nibeData.emit(req.params.id,req.body.data);
            //handleMQTT(req.body);
        });
        RED.httpAdmin.get('/config', function(req, res) {
            res.json(nibe.getConfig());
        });
        async function saveGraph() {
            const promise = new Promise((resolve,reject) => {
                let config = nibe.getConfig();
                
                    trimGraph().then(data => {
                        if(config.system.save_graph!==undefined && config.system.save_graph===true) {
                            if(savedGraph!==undefined && savedGraph.length!==0) {
                                nibe.saveGraph(savedGraph).then(result => {
                                    resolve(result);
                                },(err => {
                                    reject(err);
                                }));
                            }
                        } else {
                            reject('Not saving graphs')
                        }
                    })
                
            
        });
        return promise
        }
        function trimGraph() {
            const promise = new Promise((resolve,reject) => {
                for (var object in savedGraph) {
                    if (savedGraph.hasOwnProperty(object)) {
                        if(savedGraph[object]!==undefined && savedGraph[object].length>5000) {
                            let len = savedGraph[object].length-5000;
                            savedGraph[object].splice(0,len)
                        }
                    }
                }
                resolve()
            });
            return promise;
        }
        
        var everyminute = cron.schedule('*/1 * * * *', () => {
            if(nibe.core!==undefined && nibe.core.connected!==undefined && nibe.core.connected===true) {
                nibeData.emit('updateGraph');
                minuteUpdate();
                hotwaterPlugin();
                runFan()
            }
            
        })
        var threeminutes = cron.schedule('*/3 * * * *', () => {
            if(nibe.core!==undefined && nibe.core.connected!==undefined && nibe.core.connected===true) {
                updateData();
            }
            
        })
        var tenminutes = cron.schedule('*/10 * * * *', () => {
            if(nibe.core!==undefined && nibe.core.connected!==undefined && nibe.core.connected===true) {
                tenMinuteUpdate()
            }
        })
        
        var hourly = cron.schedule('0 * * * *', () => {
            if(nibe.core!==undefined && nibe.core.connected!==undefined && nibe.core.connected===true) {
            //let graph = this.context().global.get(`graphs`);
            saveGraph().catch(err => {
                
            });
            updateData(true);
            }
        })

    nibe.data.on('config',data => {
        if(timer.config!==undefined && timer.config._idleTimeout>0) {
            clearTimeout(timer.config);
        }
        timer.config = setTimeout(() => {
            nibeData.emit('config',data);
        }, 500);
        this.config = data;
        this.context().global.set(`config`, this.config);
    })

    
    nibe.data.on('data',data => {
        nibeData.emit(data.register,data);
        nibeData.emit('data',data);
        savedData[data.register] = data;
        saveDataGraph(data.register,Date.now(),data.raw_data)
        //console.log(`${data.register}, ${data.titel}: ${data.data} ${data.unit}`)
    })
    nibe.data.on('mqttData',data => {
        saveDataGraph(data.register,data.timestamp,data.raw_data,true)
    })
    var rmu_ready = false;
    nibe.data.on('rmu_ready',data => {
        rmu_ready = true;
        nibeData.emit('rmu_ready',data);
    });
    function checkRMU() {
        return rmu_ready;
    }
    nibe.data.on('updateSensor',data => {
        nibeData.emit('ready',true);
    })
        nibe.data.on('fault',data => {
            if(data.from=="core") {
                sendError(data.from,data.message);
                nibe.core = undefined;
                handleCore(nibe.getConfig(),true);
            } else {
                sendError(data.from,data.message);
            }
            
        })        
        this.config = nibe.getConfig();
        this.saveGraph = saveGraph;
        this.suncalc = suncalc;
        this.savedData = getSavedData;
        this.savedGraph = getSavedGraph;
        this.systems = getSystems;
        this.updateConfig = updateConfig;
        this.nibe = nibe;
        this.cron = cron;
        this.text = text;
        this.checkRMU = checkRMU;
        this.nibeData = nibeData;
        this.initiatePlugin = initiatePlugin;
        this.updateData = updateData;
        this.hotwaterPlugin = hotwaterPlugin;
        this.runTibber = getCloudData;
        this.runFan = runFan;
        this.sendError = sendError;
        this.curveAdjust = curveAdjust;
        this.hP = gethP;
        this.checkReady = checkReady;
        this.translate = translate;
        this.on('close', function() {
            console.log('Closing listeners');
            nibeData.removeAllListeners();
            nibe.data.removeAllListeners();
            everyminute.stop();
            threeminutes.stop();
            tenminutes.stop();
            hourly.stop();
            clearTimeout(timer.diagnostic);
        });
    }
    
    RED.nodes.registerType("nibe-config",nibeConfig);

}
