import React from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Typography
} from '@mui/material';
import type { WorkLog } from '../types.js';

interface WorkLogsTableProps {
  workLogs: WorkLog[];
  resourceIssues: {
    nietGewerkt: string[];
    overigeNietDeclarabel: string[];
    productontwikkeling: string[];
  };
  projectEmployees: string[]; // Nieuwe prop voor medewerkers die bij het project horen
}

export const WorkLogsTable: React.FC<WorkLogsTableProps> = ({ workLogs, resourceIssues, projectEmployees }) => {
  // Helper functie om de displayName van een author te krijgen
  const getAuthorDisplayName = (author: WorkLog['author']): string => {
    if (typeof author === 'string') {
      return author;
    }
    return author.displayName;
  };

  // Filter worklogs op basis van medewerkers die bij het project horen
  const filteredWorkLogs = workLogs.filter(log => projectEmployees.includes(getAuthorDisplayName(log.author)));

  // Groepeer worklogs per medewerker
  const workLogsByAssignee = filteredWorkLogs.reduce((acc, log) => {
    const authorName = getAuthorDisplayName(log.author);
    if (!acc[authorName]) {
      acc[authorName] = [];
    }
    acc[authorName].push(log);
    return acc;
  }, {} as Record<string, WorkLog[]>);

  // Bereken totalen voor alle categorieën
  const totals = {
    notWorked: 0,
    nonBillable: 0,
    productDev: 0
  };

  Object.values(workLogsByAssignee).forEach(logs => {
    // Log de filtering criteria
    console.info('Filtering criteria voor worklogs:');
    console.info('- Niet gewerkt: comment bevat "niet gewerkt" OF issue is in nietGewerkt lijst');
    console.info('- Overige niet-declarabel: comment bevat "overige niet-declarabel" OF issue is in overigeNietDeclarabel lijst');
    console.info('- Productontwikkeling: comment bevat "productontwikkeling" OF issue is in productontwikkeling lijst');

    // Log het aantal worklogs voor deze medewerker
    console.info(`Aantal worklogs voor deze medewerker: ${logs.length}`);

    // Filter logs voor "niet gewerkt"
    const nietGewerktLogs = logs.filter((log: WorkLog) => {
      const comment = log.comment?.toLowerCase() || '';
      const isNietGewerktComment = comment.includes('niet gewerkt') || 
                                  comment.includes('niet gewerkt') || 
                                  comment.includes('niet gewerkt') ||
                                  comment.includes('niet gewerkt');
      const isNietGewerktIssue = resourceIssues.nietGewerkt.includes(log.issueKey);
      return isNietGewerktComment || isNietGewerktIssue;
    });

    // Filter logs voor "overige niet-declarabel"
    const overigeNietDeclarabelLogs = logs.filter((log: WorkLog) => {
      const comment = log.comment?.toLowerCase() || '';
      const isOverigeNietDeclarabelComment = comment.includes('overige niet-declarabel') || 
                                            comment.includes('overige niet declarabel') ||
                                            comment.includes('niet declarabel') ||
                                            comment.includes('niet-declarabel');
      const isOverigeNietDeclarabelIssue = resourceIssues.overigeNietDeclarabel.includes(log.issueKey);
      return isOverigeNietDeclarabelComment || isOverigeNietDeclarabelIssue;
    });

    // Filter logs voor "productontwikkeling"
    const productontwikkelingLogs = logs.filter((log: WorkLog) => {
      const isNietGewerkt = nietGewerktLogs.some((nietGewerktLog: WorkLog) =>
        nietGewerktLog.issueKey === log.issueKey && 
        nietGewerktLog.started === log.started && 
        getAuthorDisplayName(nietGewerktLog.author) === getAuthorDisplayName(log.author)
      );
      
      const isOverigeNietDeclarabel = overigeNietDeclarabelLogs.some((overigeLog: WorkLog) =>
        overigeLog.issueKey === log.issueKey && 
        overigeLog.started === log.started && 
        getAuthorDisplayName(overigeLog.author) === getAuthorDisplayName(log.author)
      );

      return !isNietGewerkt && !isOverigeNietDeclarabel;
    });

    console.info(`Aantal worklogs per categorie:`);
    console.info(`- Niet gewerkt: ${nietGewerktLogs.length}`);
    console.info(`- Overige niet-declarabel: ${overigeNietDeclarabelLogs.length}`);
    console.info(`- Productontwikkeling: ${productontwikkelingLogs.length}`);

    totals.notWorked += nietGewerktLogs.reduce((sum: number, log: WorkLog) => sum + log.timeSpentSeconds, 0);
    totals.nonBillable += overigeNietDeclarabelLogs.reduce((sum: number, log: WorkLog) => sum + log.timeSpentSeconds, 0);
    totals.productDev += productontwikkelingLogs.reduce((sum: number, log: WorkLog) => sum + log.timeSpentSeconds, 0);
  });

  const grandTotal = totals.notWorked + totals.nonBillable + totals.productDev;

  return (
    <div>
      <Typography variant="h6" gutterBottom>
        Werk uren per medewerker
      </Typography>
      <TableContainer component={Paper}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Medewerker</TableCell>
              <TableCell align="right">Niet gewerkt</TableCell>
              <TableCell align="right">Overige niet-declarabel</TableCell>
              <TableCell align="right">Productontwikkeling</TableCell>
              <TableCell align="right">Totaal</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {Object.entries(workLogsByAssignee).map(([assignee, logs]) => {
              const notWorked = logs.filter(log => log.comment?.toLowerCase().includes('niet gewerkt')).reduce((sum, log) => sum + log.timeSpentSeconds, 0);
              const nonBillable = logs.filter(log => log.comment?.toLowerCase().includes('overige niet-declarabel')).reduce((sum, log) => sum + log.timeSpentSeconds, 0);
              const productDev = logs.filter(log => log.comment?.toLowerCase().includes('productontwikkeling')).reduce((sum, log) => sum + log.timeSpentSeconds, 0);
              const total = notWorked + nonBillable + productDev;

              return (
                <TableRow key={assignee}>
                  <TableCell>{assignee}</TableCell>
                  <TableCell align="right">{(notWorked / 3600).toFixed(1)}</TableCell>
                  <TableCell align="right">{(nonBillable / 3600).toFixed(1)}</TableCell>
                  <TableCell align="right">{(productDev / 3600).toFixed(1)}</TableCell>
                  <TableCell align="right">{(total / 3600).toFixed(1)}</TableCell>
                </TableRow>
              );
            })}
            <TableRow>
              <TableCell>Totaal</TableCell>
              <TableCell align="right">{(totals.notWorked / 3600).toFixed(1)}</TableCell>
              <TableCell align="right">{(totals.nonBillable / 3600).toFixed(1)}</TableCell>
              <TableCell align="right">{(totals.productDev / 3600).toFixed(1)}</TableCell>
              <TableCell align="right">{(grandTotal / 3600).toFixed(1)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </TableContainer>
    </div>
  );
}; 