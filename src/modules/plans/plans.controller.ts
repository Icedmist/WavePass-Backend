import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { PlansService } from './plans.service';
import { CreatePlanDto } from './dto/create-plan.dto';
import { UpdatePlanDto } from './dto/update-plan.dto';

@Controller('plans')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  list(@Query('venueId') venueId?: string) {
    return this.plans.listPlans(venueId);
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.plans.getPlanById(id);
  }

  @Post()
  create(@Body() dto: CreatePlanDto) {
    return this.plans.createPlan(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdatePlanDto) {
    return this.plans.updatePlan(id, dto);
  }

  @Delete(':id')
  deactivate(@Param('id') id: string) {
    return this.plans.deactivatePlan(id);
  }
}
