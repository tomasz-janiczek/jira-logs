#!/usr/bin/env bash

":" //# comment; exec /usr/bin/env node --input-type=module - "$@" < "$0"

import JiraClient from 'jira-connector';
import { start } from 'repl';
import moment from 'moment';
import * as d3 from 'd3-array';
import * as url from 'url';
import TempoApi from 'tempo-client';
import configYaml from "config-yaml";
import dotenv from 'dotenv';
import program from 'commander';
import { exit } from 'process';
import { PRIORITY_ABOVE_NORMAL } from 'constants';

const config = configYaml(`./jira.yml`);

program.version('0.0.1');
program
    .option('-s, --startDate <date>', 'start collecting the worklogs on this date')
    .option('-e, --endDate <date>', 'end collecting the worklogs on this date')
    .requiredOption('-g, --group <name>', 'collect the logs only for this group');

program.parse(process.argv);

if (config.groups[program.group] == undefined) {
    console.error(`A group named "${program.group}" does not exist`);
    process.exit(0);
}

const PMs = config.groups[program.group];

const periodStart = moment(program.startDate);
const periodEnd = moment(program.endDate);

const startDate = program.startDate;
const endDate = program.endDate;

// console.info(`START DATE: ${periodStart}`);
// console.info(`END DATE: ${periodEnd}`);

const startedBreakout = started => {
    const match = started.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/);
    return {
        date: match[1],
        time: match[2],
    };
};

const secondsToHours = seconds => seconds / 3600.0;

//console.log(config.instances);

let hosts = config.instances;

const getPeopleList = () => {
    let PMList = [];

    PMs.forEach((value, key) => {
        PMList[key] = `'${value}'`;
    });
    PMList = PMList.join(',');

    return PMList;
};

function createJiraClient(host) {
    let jira = new JiraClient({
        host: host.url,
        basic_auth: {
            email: host.email,
            api_token: host.api_token,
        },
    });

    return jira;
}

function createTempoClient(host) {
    const tempo = new TempoApi.default({
        protocol: 'https',
        host: 'api.tempo.io',
        bearerToken: host.tempo_api_token,
        apiVersion: '3',
    });

    return tempo;
}

const createDummyInitialJiraWorklog = () => {
    let since = periodStart.valueOf();
    let worklog = {
        nextPage: `http://foo.bar/x?since=${since}`,
        lastPage: false,
    };

    return worklog;
};

const createDummyInitialTempoWorklog = () => {
    let since = periodStart.format('YYYY-MM-DD');
    let worklog = {
        next: `http://foo.bar/x?updatedFrom=${since}&offset=0&limit=1000`,
    };

    return worklog;
};

let sum = [];

async function checkForJiraTempo(host) {
    let usesTempo = false;

    const jira = createJiraClient(host);
    const users = await jira.user.all({ startAt: 0, maxResults: 1000 });
    //console.log(users);

    for (var index in users) {
        let entry = users[index];

        //console.log(entry.accountType, entry.displayName);
        if (entry.displayName.includes('Tempo Timesheets')) {
            usesTempo = true;
            break;
        }
    }

    return usesTempo;
}

async function fetchRawJiraWorklogs(host) {
    let rawWorklogs = [];
    let worklogPage = createDummyInitialJiraWorklog();

    const jira = createJiraClient(host);

    while (!worklogPage.lastPage) {
        // Parse the URL of the next worklog page
        let nextPageUrl = new URL(worklogPage.nextPage);

        // Fetch a list of all worklogs (that's not a list of the worklogs itself!)
        // modified since the value of 'since'
        worklogPage = await jira.worklog.getWorklogUpdated({
            since: nextPageUrl.searchParams.get('since'),
        });

        // Extract only the raw IDs of the worklogs (again - these are the IDs, not the worklogs itself!)
        let worklogIds = worklogPage.values.map(worklogEntry => {
            return worklogEntry.worklogId;
        });

        // And now fetch the full worklogs by id(s)
        let _rawWorklogs = await jira.worklog.worklogList({ ids: worklogIds });
        rawWorklogs = rawWorklogs.concat(_rawWorklogs);
    }

    const worklogs = rawWorklogs.map(
        ({
            author: { accountId, displayName },
            created,
            updated,
            started,
            timeSpentSeconds,
        }) => ({
            accountId,
            name: displayName,
            created: startedBreakout(created),
            updated: startedBreakout(updated),
            started: startedBreakout(started),
            timeSpentSeconds,
            timeSpentHours: secondsToHours(timeSpentSeconds),
        })
    );

    return worklogs;
}

async function fetchRawTempoWorklogs(host) {
    let rawWorklogs = [];
    let worklogPage = createDummyInitialTempoWorklog();

    const tempo = createTempoClient(host);

    while (worklogPage.next) {
        // Parse the URL of the next worklog page
        let nextPageUrl = new URL(worklogPage.next);

        // Fetch a list of all worklogs (that's not a list of the worklogs itself!)
        // modified since the value of 'since'
        worklogPage = await tempo.worklogs.get({
            updatedFrom: nextPageUrl.searchParams.get('updatedFrom'),
            offset: nextPageUrl.searchParams.get('offset'),
            limit: nextPageUrl.searchParams.get('limit'),
        });

        //console.log(worklogPage);return;

        rawWorklogs = rawWorklogs.concat(worklogPage.results);
    }

    const worklogs = rawWorklogs.map(
        ({
            author: { accountId, displayName },
            createdAt,
            updatedAt,
            startDate,
            startTime,
            timeSpentSeconds,
        }) => ({
            accountId,
            name: displayName,
            created: startedBreakout(createdAt),
            updated: startedBreakout(updatedAt),
            started: {
                date: startDate,
                time: startTime,
            },
            timeSpentSeconds,
            timeSpentHours: secondsToHours(timeSpentSeconds),
        })
    );

    return worklogs;
}

console.info(`Fetching logs for the following people: ${PMs}`);

async function getSprintList(jira, boardId) {
    let opts = {};

    var options = {
        uri: decodeURIComponent(url.format({
            protocol: jira.protocol,
            hostname: jira.host,
            port: jira.port,
            pathname: '/rest/greenhopper/1.0/sprintquery/' + boardId + '?includeFutureSprints=false'
        })),
        method: 'GET',
        json: true,
        followAllRedirects: true
    };

    return jira.makeRequest(options);
}

function getActiveSprints(sprints) {
    let activeSprints = [];

    sprints.sprints.forEach(sprint => {
        if (sprint.state == 'ACTIVE') {
            activeSprints.push(sprint);
        }
    })

    return activeSprints;
}

async function getSprint(jira, sprintId) {
    let sprint = await jira.sprint.getSprint({ sprintId: sprintId });
    let issues = await jira.sprint.getSprintIssues({ sprintId: sprintId, maxResults: 100 });

    sprint.issues = issues.issues;
    sprint.totals = {
        originalEstimateSeconds: 0,
        remainingEstimateSeconds: 0,
        timeSpentSeconds: 0,
        issuesWithoutAsignee: 0,
        issuesWithoutEstimate: 0,
        issuesTotal: sprint.issues.length,
    };

    //console.log(sprint.issues[0].fields.timetracking);
    //return sprint;

    sprint.issues.forEach(issue => {
        //console.log(issue.fields.timetracking);
        if (issue.fields.timetracking.originalEstimateSeconds) {
            sprint.totals.originalEstimateSeconds += issue.fields.timetracking.originalEstimateSeconds;
        }

        if (issue.fields.timetracking.remainingEstimateSeconds) {
            sprint.totals.remainingEstimateSeconds += issue.fields.timetracking.remainingEstimateSeconds;
        }

        if (issue.fields.timetracking.timeSpentSeconds) {
            sprint.totals.timeSpentSeconds += issue.fields.timetracking.timeSpentSeconds;
        }

        if (!issue.fields.assignee) {
            sprint.totals.issuesWithoutAsignee++;
        }

        if (!issue.fields.timetracking.originalEstimateSeconds && !issue.fields.timetracking.remainingEstimateSeconds) {
            sprint.totals.issuesWithoutEstimate++;
        }
    });

    //console.log(sprint.issues[0].fields.assignee);

    sprint.totals.originalEstimateHours = sprint.totals.originalEstimateSeconds / (60 * 60);
    sprint.totals.remainingEstimateHours = sprint.totals.remainingEstimateSeconds / (60 * 60);
    sprint.totals.timeSpentHours = sprint.totals.timeSpentSeconds / (60 * 60);

    //let issues = await jira.sprint.getSprintIssues({ sprintId: 1255 });
    //console.log(sprint);
    //console.log(issues);

    return sprint;
}

let PR = ['PER', 'BRDD', 'THS'];

async function getAllProjects(jira) {
    let projects = await jira.project.getAllProjects();
    let p = [];

    for (let key in projects) {
        console.log("PRoject " + projects[key].name + " " + projects[key].key);

        if (!PR.includes(projects[key].key)) {
            continue;
        }

        if (projects[key].isPrivate) {
            continue;
        }

        console.log("GO!");

        try {
            let boards = await jira.board.getAllBoards({
                type: 'scrum',
                projectKeyOrId: projects[key].key
            });
            projects[key].boards = boards.values;
            //console.log(boards);
        } catch (e) {
            console.error(e);
        }

        p.push(projects[key]);
    }

    return p;
}

async function checkAllProjects(jira) {
    let projects = await getAllProjects(jira);

    for (let key in projects) {
        let project = projects[key];

        if (!project.boards.length) {
            continue;
        }

        //console.log(project.boards[0]);

        //    console.log(hosts[0]);
        let sprints = await getSprintList(jira, project.boards[0].id);
        console.log(sprints);
        //return;
        let activeSprints = getActiveSprints(sprints);
        console.log(activeSprints[0]);
        //return;

        if (!activeSprints.length) {
            console.log("No active sprints");
            continue;
        }

        let sprint = await getSprint(jira, activeSprints[0].id);
        //console.log(sprint.issues[0].fields);
        sprint.issues = [];
        console.log(sprint);
        console.log(sprint.totals);
        console.log('END');
    }

    return projects;
}

async function foo() {
    let jira = createJiraClient(hosts[0]);

    return checkAllProjects(jira);
}

foo();


// hosts.forEach(host => {
//     (async() => {
//         console.info(`--==[ ${host.url} ]==--`);

//         let isTempo = await checkForJiraTempo(host);
//         //return;

//         let rawWorklogs = [];

//         if (true == host.is_tempo) {
//             rawWorklogs = await fetchRawTempoWorklogs(host);
//         } else {
//             rawWorklogs = await fetchRawJiraWorklogs(host);
//         }

//         //console.log(rawWorklogs);
//         //return;

//         let worklogsFiltered = rawWorklogs.filter(value => {
//             let createdDate = moment(value.started.date);
//             let people = getPeopleList();

//             if (!people.includes(value.name)) {
//                 //console.log("FILTER OUT " + value.name);
//                 return false;
//             }
//             if (!createdDate.isBetween(startDate, endDate, undefined, '[]')) {
//                 //console.log(value.created.date);
//                 return false;
//             }

//             return true;
//         });

//         //console.log(rawWorklogs);

//         worklogsFiltered.forEach(value => {
//             //console.log(value);
//             if (sum[value.name] == undefined) {
//                 sum[value.name] = [];
//             }
//             if (sum[value.name][host.url] == undefined) {
//                 sum[value.name][host.url] = { total: 0 };
//             }

//             sum[value.name][host.url].total += value.timeSpentHours;
//         });

//         console.log(`JIRA ${host.url} (${worklogsFiltered.length} entries, uses Tempo: ${isTempo})`);
//         //console.log(sum);

//         let stat = [];

//         for (var index in sum) {
//             if (stat[index] == undefined) {
//                 stat[index] = 0;
//             }

//             //console.log(sum[index]);

//             for (var f in sum[index]) {
//                 //console.log("a: " + f);
//                 stat[index] += sum[index][f].total;
//             }
//         }

//         console.log('---=== [ FINAL STATS ]===---');
//         console.log(stat);
//     })();
// });