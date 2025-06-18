import { getActiveIssues, isEETIssue, formatTime } from './jira.js';
import Table from 'cli-table3';

interface IssueLink {
  type: {
    name: string;
    inward: string;
    outward: string;
  };
  inwardIssue?: {
    key: string;
  };
  outwardIssue?: {
    key: string;
  };
}

function truncateString(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}

function formatStatus(status: string): string {
  if (status === 'Ready for te...') return 'Ready for testing';
  return status;
}

function getPredecessors(issue: any): string {
  if (!issue.fields.issuelinks) return '-';
  const predecessors = issue.fields.issuelinks
    .filter((link: any) => link.type.name === 'has as a predecessor')
    .map((link: any) => link.inwardIssue?.key || link.outwardIssue?.key)
    .filter(Boolean);
  return predecessors.length > 0 ? predecessors.join(', ') : '-';
}

function getSuccessors(issue: any): string {
  if (!issue.fields.issuelinks) return '-';
  const successors = issue.fields.issuelinks
    .filter((link: any) => link.type.name === 'is a predecessor of')
    .map((link: any) => link.inwardIssue?.key || link.outwardIssue?.key)
    .filter(Boolean);
  return successors.length > 0 ? successors.join(', ') : '-';
}

function getParent(issue: any): string {
  return issue.fields.parent?.key || '-';
}

function printTable(issues: any[]) {
  const table = new Table({
    head: [
      'Issue Key',
      'Samenvatting',
      'Status',
      'Toegewezen aan',
      'Points',
      'Orig. Time',
      'Rem. Time',
      'Predecessors',
      'Successors',
      'Parent'
    ],
    style: {
      head: ['cyan'],
      border: ['gray']
    },
    colWidths: [12, 40, 15, 20, 8, 10, 10, 15, 15, 10],
    chars: {
      'top': '─', 'top-mid': '┬', 'top-left': '┌', 'top-right': '┐',
      'bottom': '─', 'bottom-mid': '┴', 'bottom-left': '└', 'bottom-right': '┘',
      'left': '│', 'left-mid': '├', 'mid': '─', 'mid-mid': '┼',
      'right': '│', 'right-mid': '┤', 'middle': '│'
    },
    wordWrap: true
  });

  for (const issue of issues) {
    console.log(`\nRelaties voor issue ${issue.key}:`);
    if (issue.fields.issuelinks) {
      const uniqueTypes = new Set(issue.fields.issuelinks.map((link: IssueLink) => link.type.name));
      uniqueTypes.forEach(type => {
        console.log(`- ${type}`);
      });
    } else {
      console.log('Geen relaties gevonden');
    }

    // Verzamel voorgangers en opvolgers
    const predecessors: string[] = [];
    const successors: string[] = [];
    
    if (issue.fields.issuelinks) {
      issue.fields.issuelinks.forEach((link: IssueLink) => {
        // Check voor voorganger/opvolger relaties
        if (link.type.name === 'Predecessor') {
          // Als dit issue een voorganger heeft, voeg die toe aan de voorgangers
          if (link.inwardIssue) {
            predecessors.push(link.inwardIssue.key);
          }
          // Als dit issue een opvolger heeft, voeg die toe aan de opvolgers
          if (link.outwardIssue) {
            successors.push(link.outwardIssue.key);
          }
        }
      });
    }

    table.push([
      issue.key,
      issue.fields.summary,
      issue.fields.status.name,
      issue.fields.assignee?.displayName || 'Niet toegewezen',
      issue.fields.customfield_10002 || '-',
      issue.fields.timeoriginalestimate ? (issue.fields.timeoriginalestimate / 3600).toFixed(1) : '-',
      issue.fields.timeestimate ? (issue.fields.timeestimate / 3600).toFixed(1) : '-',
      predecessors.length > 0 ? predecessors.join(', ') : '-',
      successors.length > 0 ? successors.join(', ') : '-',
      issue.fields.parent?.key || '-'
    ]);
  }

  console.log(table.toString());
}

async function testJiraIntegration() {
  try {
    console.log('Ophalen van actieve issues...');
    const issues = await getActiveIssues();
    
    console.log('\nGevonden issues:');
    printTable(issues);
  } catch (error) {
    console.error('Fout bij het ophalen van issues:', error);
  }
}

testJiraIntegration(); 